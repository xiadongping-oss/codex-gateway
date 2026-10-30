use serde::{
    de::{self, MapAccess, SeqAccess, Visitor},
    Deserialize, Deserializer,
};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    io::{BufRead, Write},
    path::Path,
    process::{Child, ChildStdin},
    sync::mpsc::{Receiver, RecvTimeoutError},
    time::Duration,
};

const MAX_FRAME: usize = 64 * 1024;
// Preserve duplicate-key rejection at every nesting level before Value loses it.
struct Unique(Value);
impl<'de> Deserialize<'de> for Unique {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Unique;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("unique JSON")
            }
            fn visit_bool<E: de::Error>(self, v: bool) -> Result<Unique, E> {
                Ok(Unique(v.into()))
            }
            fn visit_i64<E: de::Error>(self, v: i64) -> Result<Unique, E> {
                Ok(Unique(v.into()))
            }
            fn visit_u64<E: de::Error>(self, v: u64) -> Result<Unique, E> {
                Ok(Unique(v.into()))
            }
            fn visit_f64<E: de::Error>(self, v: f64) -> Result<Unique, E> {
                Ok(Unique(json!(v)))
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Unique, E> {
                Ok(Unique(v.into()))
            }
            fn visit_unit<E: de::Error>(self) -> Result<Unique, E> {
                Ok(Unique(Value::Null))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> Result<Unique, A::Error> {
                let mut v = vec![];
                while let Some(Unique(x)) = a.next_element()? {
                    v.push(x)
                }
                Ok(Unique(v.into()))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> Result<Unique, A::Error> {
                let mut v = serde_json::Map::new();
                let mut keys = HashSet::new();
                while let Some(key) = a.next_key::<String>()? {
                    if !keys.insert(key.clone()) {
                        return Err(de::Error::custom("duplicate key"));
                    }
                    let Unique(value) = a.next_value()?;
                    v.insert(key, value);
                }
                Ok(Unique(v.into()))
            }
        }
        d.deserialize_any(V)
    }
}
pub fn parse(bytes: &[u8]) -> Result<Value, String> {
    if bytes.len() > MAX_FRAME
        || bytes.last() != Some(&b'\n')
        || bytes.starts_with(&[0xef, 0xbb, 0xbf])
    {
        return Err("FRAME_INVALID".into());
    }
    let value = serde_json::from_slice::<Unique>(bytes)
        .map_err(|_| "FRAME_INVALID")?
        .0;
    fn depth(v: &Value, n: usize) -> bool {
        n <= 64
            && match v {
                Value::Array(a) => a.iter().all(|v| depth(v, n + 1)),
                Value::Object(m) => m.values().all(|v| depth(v, n + 1)),
                _ => true,
            }
    }
    if !value.is_object() || !depth(&value, 0) {
        return Err("FRAME_INVALID".into());
    }
    Ok(value)
}
pub fn read_frame(input: &mut impl BufRead) -> Result<Vec<u8>, String> {
    let mut result = Vec::new();
    loop {
        let buf = input.fill_buf().map_err(|_| "CONTROL_CHANNEL_LOST")?;
        if buf.is_empty() {
            return Err("CONTROL_CHANNEL_LOST".into());
        }
        let count = buf
            .iter()
            .position(|b| *b == b'\n')
            .map_or(buf.len(), |i| i + 1);
        if result.len() + count > MAX_FRAME {
            return Err("FRAME_INVALID".into());
        }
        result.extend_from_slice(&buf[..count]);
        input.consume(count);
        if result.last() == Some(&b'\n') {
            return Ok(result);
        }
    }
}
pub struct Session {
    pub lease: Option<crate::recovery::Lease>,
    pub tree: Option<crate::process_tree::Tree>,
    pub alive: std::sync::Arc<std::sync::atomic::AtomicBool>,
    pub child: Child,
    pub input: Option<ChildStdin>,
    pub frames: Receiver<Result<Vec<u8>, String>>,
    pub launch_id: String,
    pub challenge: String,
    seq: u64,
    received: u64,
    pending: HashMap<u64, String>,
}
impl Session {
    pub fn new(mut child: Child, frames: Receiver<Result<Vec<u8>, String>>) -> Self {
        let mut random = [0u8; 32];
        getrandom::fill(&mut random).expect("OS randomness unavailable");
        Self {
            lease: None,
            tree: None,
            alive: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true)),
            input: child.stdin.take(),
            child,
            frames,
            launch_id: uuid::Uuid::new_v4().to_string(),
            challenge: random.iter().map(|b| format!("{b:02x}")).collect(),
            seq: 0,
            received: 0,
            pending: HashMap::new(),
        }
    }
    pub fn send(&mut self, kind: &str, payload: Value) -> Result<u64, String> {
        if self.pending.len() >= 16 {
            return Err("CONTROL_CHANNEL_LOST".into());
        }
        self.seq += 1;
        let frame = json!({"protocol":"cgw.desktop","version":1,"launchId":self.launch_id,"seq":self.seq,"requestId":self.seq,"kind":"request","type":kind,"payload":payload});
        let bytes = format!("{frame}\n");
        self.input
            .as_mut()
            .ok_or("CONTROL_CHANNEL_LOST")?
            .write_all(bytes.as_bytes())
            .map_err(|_| "CONTROL_CHANNEL_LOST")?;
        self.pending.insert(self.seq, kind.to_string());
        Ok(self.seq)
    }
    pub fn next(&mut self, timeout: Duration) -> Result<Option<Value>, String> {
        let bytes = match self.frames.recv_timeout(timeout) {
            Ok(v) => v?,
            Err(RecvTimeoutError::Timeout) => return Ok(None),
            Err(_) => return Err("CONTROL_CHANNEL_LOST".into()),
        };
        self.accept(&bytes).map(Some)
    }
    fn accept(&mut self, bytes: &[u8]) -> Result<Value, String> {
        let v = parse(bytes)?;
        if v["protocol"] != "cgw.desktop"
            || v["version"] != 1
            || v["launchId"] != self.launch_id
            || v["seq"].as_u64() != Some(self.received + 1)
            || !v["payload"].is_object()
        {
            return Err("IDENTITY_MISMATCH".into());
        }
        let fields = v.as_object().unwrap();
        if fields.keys().any(|k| {
            ![
                "protocol",
                "version",
                "launchId",
                "seq",
                "requestId",
                "kind",
                "type",
                "payload",
                "ok",
                "error",
            ]
            .contains(&k.as_str())
        }) {
            return Err("FRAME_INVALID".into());
        }
        let kind = v["type"].as_str().ok_or("FRAME_INVALID")?;
        match v["kind"].as_str() {
            Some("response") => {
                let id = v["requestId"].as_u64().ok_or("FRAME_INVALID")?;
                if self.pending.remove(&id).as_deref() != Some(kind) || !v["ok"].is_boolean() {
                    return Err("FRAME_INVALID".into());
                }
                let ok = v["ok"] == true;
                if fields.len() != if ok { 9 } else { 10 }
                    || (ok && fields.contains_key("error"))
                    || (!ok && !v["error"].is_object())
                {
                    return Err("FRAME_INVALID".into());
                }
            }
            Some("event")
                if fields.len() == 7
                    && [
                        "ready",
                        "fatal",
                        "shutdown.progress",
                        "shutdown.waiting",
                        "stopped",
                    ]
                    .contains(&kind) => {}
            _ => return Err("FRAME_INVALID".into()),
        }
        self.received += 1;
        Ok(v)
    }
    pub fn verify_identity(&self, value: &Value, root: &Path, version: &str) -> Result<(), String> {
        let p = &value["payload"];
        let same_root = p["resourceRoot"]
            .as_str()
            .and_then(|p| dunce::canonicalize(p).ok())
            .as_deref()
            == Some(root);
        if value["kind"] != "response"
            || value["type"] != "initialize"
            || value["ok"] != true
            || p["state"] != "initialized"
            || p["pid"].as_u64() != Some(self.child.id() as u64)
            || p["challenge"] != self.challenge
            || p["appVersion"] != version
            || !same_root
        {
            return Err("IDENTITY_MISMATCH".into());
        }
        Ok(())
    }
    pub fn cleanup(&mut self) -> bool {
        self.alive.store(false, std::sync::atomic::Ordering::SeqCst);
        self.input.take();
        let end = std::time::Instant::now() + Duration::from_secs(6);
        while std::time::Instant::now() < end {
            if matches!(self.child.try_wait(), Ok(Some(_))) {
                return self
                    .tree
                    .as_mut()
                    .is_none_or(|t| t.terminate(&mut self.child));
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        let tree_empty = self
            .tree
            .as_mut()
            .is_none_or(|t| t.terminate(&mut self.child));
        let _ = self.child.kill();
        self.child.wait().is_ok() && tree_empty
    }
    pub fn pending(&self, kind: &str) -> bool {
        self.pending.values().any(|k| k == kind)
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.cleanup();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn session() -> Session {
        let root = std::env::var("CGW_BUILD_RESOURCES").unwrap();
        let node = Path::new(&root).join(if cfg!(windows) {
            "runtime/node.exe"
        } else {
            "runtime/node"
        });
        let mut command = std::process::Command::new(node);
        command.args(["-e", ""]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let child = command.spawn().unwrap();
        let (_tx, rx) = std::sync::mpsc::channel();
        Session::new(child, rx)
    }
    #[test]
    fn responses_bind_identity_sequence_and_pending_command() {
        for field in [
            "launchId",
            "seq",
            "version",
            "requestId",
            "type",
            "extra",
            "ok",
        ] {
            let mut s = session();
            s.pending.insert(1, "initialize".into());
            let mut frame = json!({"protocol":"cgw.desktop","version":1,"launchId":s.launch_id,"seq":1,"requestId":1,"kind":"response","type":"initialize","ok":true,"payload":{}});
            frame[field] = json!("invalid");
            assert!(
                s.accept(format!("{frame}\n").as_bytes()).is_err(),
                "{field}"
            );
        }
        let mut s = session();
        s.pending.insert(1, "status".into());
        let frame = json!({"protocol":"cgw.desktop","version":1,"launchId":s.launch_id,"seq":1,"requestId":1,"kind":"response","type":"status","ok":true,"payload":{}});
        assert!(s.accept(format!("{frame}\n").as_bytes()).is_ok());
        assert!(s.accept(format!("{frame}\n").as_bytes()).is_err());
    }
    #[test]
    fn initialize_checks_actual_child_challenge_version_and_root() {
        let s = session();
        let root = dunce::canonicalize(std::env::temp_dir()).unwrap();
        let frame = json!({"kind":"response","type":"initialize","ok":true,"payload":{"state":"initialized","pid":s.child.id(),"challenge":s.challenge,"appVersion":"1.12.1","resourceRoot":root}});
        assert!(s.verify_identity(&frame, &root, "1.12.1").is_ok());
        for field in ["pid", "challenge", "appVersion", "resourceRoot", "state"] {
            let mut bad = frame.clone();
            bad["payload"][field] = json!("incorrect");
            assert!(s.verify_identity(&bad, &root, "1.12.1").is_err(), "{field}");
        }
    }
    #[test]
    fn invalid_frames_are_rejected() {
        for frame in [
            "\n",
            "{\"a\":1,\"a\":2}\n",
            "{\"a\":{\"x\":1,\"\\u0078\":2}}\n",
            "[]\n",
            "{}",
        ] {
            assert!(parse(frame.as_bytes()).is_err());
        }
        assert!(parse(&[0xc0, 0x80, b'\n']).is_err());
        assert!(parse(format!("{{\"a\":\"{}\"}}\n", "x".repeat(MAX_FRAME)).as_bytes()).is_err());
        assert!(parse(b"{\"a\":[1,null,true,\"text\"]}\n").is_ok());
    }
    #[test]
    fn reads_are_bounded_and_leave_next_frame() {
        let mut r = std::io::Cursor::new(b"{}\n{\"b\":1}\n");
        assert_eq!(read_frame(&mut r).unwrap(), b"{}\n");
        assert_eq!(read_frame(&mut r).unwrap(), b"{\"b\":1}\n");
        assert!(read_frame(&mut r).is_err());
        assert!(read_frame(&mut std::io::Cursor::new(vec![b'x'; MAX_FRAME + 1])).is_err());
    }
}
