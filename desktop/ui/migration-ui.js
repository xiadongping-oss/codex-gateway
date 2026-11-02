(() => {
  const el = id => document.getElementById('migration-' + id)
  const invoke = request => window.__TAURI__.core.invoke('migration_request', { request })
  const SIZE_LIMIT_MB = 512

  // 错误码到「发生了什么 + 接下来怎么做」。迁移是破坏性操作，出问题时用户最需要
  // 知道的是「数据还在吗、我该做什么」，而不是内部代号。
  const messages = {
    MIGRATION_SOURCE_MISSING: '找不到这个目录，请核对路径是否完整、盘符是否正确。数据没有被改动。',
    MIGRATION_SOURCE_NOT_DETECTED: '这个位置还没有通过扫描确认，不能直接删除。只有扫描找到的旧数据才提供删除。',
    ENOENT: '有文件或目录不存在，可能已经被移动过。数据没有被改动。',
    MIGRATION_ABSOLUTE_PATH_REQUIRED: '请填写完整的绝对路径，例如 C:\\Users\\你的名字\\AppData\\Local\\CodexGateway。',
    MIGRATION_INVALID_ACCOUNTS: '账号注册表和凭据文件对不上，请在旧版里再启动一次确认能正常使用。未进行迁移。',
    MIGRATION_INVALID_JSON: '旧数据里有文件不完整，请先修复或删除损坏的文件。原文件已保留。',
    MIGRATION_INVALID_STORE: '旧数据格式不受支持，无法迁移。原文件已保留。',
    MIGRATION_SOURCE_CHANGED: '检查之后旧数据又变了。请先退出还在写入的程序，然后重新核对一次。',
    MIGRATION_PLAN_CHANGED: '要迁移的内容已经变了，请回到上一步重新核对。',
    MIGRATION_PLAN_REQUIRED: '请先重新核对要迁移的内容。',
    MIGRATION_DATA_IN_USE: '旧数据仍在被使用。请从旧版入口完全退出网关，再回来重试。',
    MIGRATION_GATEWAY_ACTIVE: '本机网关还在运行或正在退出，请等它停下后再迁移。',
    MIGRATION_STOP_CONFIRMATION_REQUIRED: '请先退出旧网关和其他正在写入这些数据的程序，再勾选确认框。',
    MIGRATION_PENDING_LOGIN: '旧目录里还有没走完的登录流程，请先在旧版里完成或取消它。',
    MIGRATION_TARGET_EXISTS: '桌面版工作空间里已经有数据了，不能直接合并。要在「数据与备份」里先处理现有数据。',
    MIGRATION_LAYOUT_UNSUPPORTED: '旧目录的数据版本比桌面版更新，不能降级迁移。请升级桌面版后再试。',
    MIGRATION_CONTENT_CHANGED: '现有数据或备份发生了变化，已拒绝覆盖。请保留文件并检查。',
    MIGRATION_PATH_REVIEW_REQUIRED: '配置里引用了需要确认的文件位置，请展开「外部文件位置」指定完整路径。',
    MIGRATION_EXTERNAL_PATH_REVIEW_REQUIRED: '这个旧数据引用了目录之外的文件，需要人工核对位置，暂时不能自动迁移。',
    MIGRATION_PATH_NOT_COPIED: '配置引用了本次不会复制的文件，请明确指定它的位置。',
    MIGRATION_INCOMPLETE_SNAPSHOT: '上一次还没复制完，或者回退正在进行。请先取消并恢复，再重新开始。',
    MIGRATION_UNKNOWN_TRANSACTION: '无法验证这次迁移记录。请保留旧目录和备份，不要删除保护目录后强行启动。',
    MIGRATION_INTERRUPTED: '迁移中断了。如果留下了未完成的记录，下次打开可以接着处理或取消。',
    MIGRATION_LINK_REFUSED: '数据里有链接文件或链接目录，请先核对它们真实存放的位置。',
    MIGRATION_NESTED_BACKUP_REVIEW_REQUIRED: '旧目录里已经有一份迁移备份，需要单独核对，暂不自动迁移。',
    MIGRATION_EMPTY_SOURCE: '这个目录里没有可迁移的数据，请换一个目录。旧目录不会被改动。',
    MIGRATION_BUSY: '还有一次迁移在处理中，请等它结束再操作。',
    MIGRATION_BACKUP_REVIEW_REQUIRED: '请先重新检查要回退的那份备份。',
    MIGRATION_ARCHIVE_REQUIRED: '找不到这次迁移的备份记录，无法继续。请保留旧目录与备份，不要手动删除。',
    MIGRATION_INVALID_ARGUMENT: '这次请求不完整（通常是界面状态已过期），请重新走一遍。数据未改动。',
    MIGRATION_INVALID_REPLY: '迁移程序返回的结果无法识别，操作已中止。数据未改动。',
    MIGRATION_WORKER_UNCONFIRMED: '无法确认迁移程序已就绪，操作已中止以免改写正在使用的数据。请稍后重试。',
    MIGRATION_FAILED: '操作没有完成。旧目录和已有备份都原样保留，请核对后重试。',
    PROCESS_TREE_UNAVAILABLE: '无法确认相关进程已经退出，已中止操作。请稍后重试，数据未改动。',
    DATA_MIGRATION_REQUIRED: '这次启动前的迁移没有完成，请先处理迁移再使用数据。',
    DATA_MIGRATION_PENDING: '上一次迁移还没收尾，请先继续或取消它。',
    DATA_DIR_UNWRITABLE: '数据目录无法写入，请检查磁盘权限或换一个位置。数据未改动。',
    DATA_VERSION_UNSUPPORTED: '现有数据的版本不受支持，请升级应用后再试。',
    DATA_DIR_INVALID: '数据位置不可用，不能和程序目录重叠或指向链接。',
    RESOURCES_INVALID: '应用资源校验失败，请重新安装完整的应用。'
  }
  const describe = error => messages[String(error)] || '操作没有完成。旧目录和已有备份都原样保留，请核对后重试。'
  // 候选为什么不能自动迁移 —— 展示在图卡上，而不是默默禁用。
  const reviewNotes = {
    MIGRATION_SIZE_REVIEW_REQUIRED: `数据超过 ${SIZE_LIMIT_MB} MB，需要你确认后再迁移`,
    MIGRATION_EXTERNAL_PATH_REVIEW_REQUIRED: '引用了目录之外的文件，需要人工核对',
    MIGRATION_TARGET_EXISTS: '桌面版工作空间已有数据',
    MIGRATION_DATA_IN_USE: '旧数据正在被占用，请先退出旧版网关',
    MIGRATION_GATEWAY_ACTIVE: '网关仍在运行',
    MIGRATION_PENDING_LOGIN: '旧目录里有未完成的登录',
    MIGRATION_LINK_REFUSED: '数据里有链接文件'
  }
  const kindLabel = kind => (kind === 'gateway' ? '便携版 gateway 目录' : '桌面版旧数据目录')
  const mb = bytes => (bytes / 1048576).toFixed(bytes < 10485760 ? 2 : 0)

  // ---- 单一状态源：所有渲染都从这里出发，不再各自 hidden 切换 --------------
  const state = {
    view: 'loading',      // loading | source | gallery | review | running | result | recovery
    step: 'source',       // source | gallery | review | done
    context: null,
    candidates: [],
    selected: null,
    galleryChoice: 'import',
    plan: null,
    result: null,
    busy: false,
    loading: false,
    visible: false,
    lastCode: null,
    lastVisible: false,
    planning: false
  }

  // 这些阶段 = 网关进程真的持有数据目录，任何迁移请求都会被后端拒绝。
  const RUNNING_PHASES = ['starting', 'ready', 'stopping', 'unresponsive']
  const views = {}
  for (const node of document.querySelectorAll('#migration-views [data-view]')) views[node.dataset.view] = node
  const STEP_ORDER = ['source', 'gallery', 'review', 'done']

  function setView(view) {
    state.view = view
    for (const [name, node] of Object.entries(views)) node.hidden = name !== view
  }
  function setStep(step) {
    state.step = step
    const current = STEP_ORDER.indexOf(step)
    let shown = 0
    for (const item of el('steps').children) {
      const own = STEP_ORDER.indexOf(item.dataset.step)
      // 「处理图片」在没有图片时整步跳过，序号不能因此断档。
      const hidden = item.dataset.step === 'gallery' && !hasGallery()
      item.hidden = hidden
      if (!hidden) shown += 1
      item.querySelector('b').textContent = String(shown)
      item.classList.toggle('current', own === current)
      item.classList.toggle('done', own < current)
    }
  }
  // 手动指定目录时我们没扫过图库，所以只知道「用户说有这个目录」，不知道里面有几张。
  const GALLERY_COUNT_UNKNOWN = -1
  const hasGallery = () => Boolean(state.selected && state.selected.galleryFiles)

  function setBusy(value, label) {
    state.busy = value
    if (label != null) el('running-text').textContent = label
    render()
  }

  // ---- 渲染 -----------------------------------------------------------------
  // 界面上只讲人话，但原始错误码留在 DOM 上：原生窗口里没有开发者工具，
  // 冒烟脚本失败时这是唯一能读到内部原因的地方。
  function renderError(text, code) {
    el('error').textContent = text || ''
    if (code != null) el('panel').dataset.lastError = String(code)
  }
  function renderActions(options) {
    const { back, main, alt, start } = options || {}
    const busy = state.busy || state.loading
    const place = (id, spec) => {
      const node = el(id)
      node.hidden = !spec
      if (spec) {
        node.textContent = spec.label
        node.onclick = spec.onClick
        node.disabled = busy || Boolean(spec.disabled)
        node.className = spec.danger ? 'danger' : (id === 'main' || id === 'start' ? '' : 'secondary')
      }
      return node
    }
    place('back', back)
    place('main', main)
    place('alt', alt)
    place('start', start)
  }
  function render() {
    const busy = state.busy || state.loading
    renderStepBadge()
    el('recovery').hidden = state.view !== 'recovery'
    // 所有表单控件随忙闲状态锁定
    for (const node of document.querySelectorAll('#migration-views input, #migration-views select, #migration-views button')) node.disabled = busy
    // 确认框在最后一步单独控制：它是「迁移」按钮的前置条件，不是流程锁
    if (views.review.hidden === false) {
      el('stopped').disabled = busy
      // 「为什么点不了」必须写出来：禁用的主按钮本身不说任何话。
      el('hint').textContent = busy ? '' : (el('stopped').checked ? '' : '先勾选上面的确认，才能开始迁移。')
      renderActions({
        back: { label: '上一步', onClick: () => go('gallery') },
        main: { label: '备份并迁移', onClick: apply, disabled: !el('stopped').checked || !state.plan }
      })
      return
    }
    el('hint').textContent = ''
    if (state.view === 'source') {
      const picked = Boolean(state.selected)
      const deletable = picked && !state.selected.manual
      renderActions({
        main: { label: '下一步', onClick: next, disabled: !picked },
        alt: deletable ? { label: '删除这份旧数据', onClick: discardSelected, danger: true } : null
      })
    } else if (state.view === 'gallery') {
      renderActions({ back: { label: '上一步', onClick: () => go('source') }, main: { label: '下一步', onClick: next } })
    } else if (state.view === 'recovery') {
      renderActions({
        main: { label: '继续上次迁移', onClick: () => finish('resume', '正在核对备份并继续上一次迁移…') },
        alt: { label: '取消并恢复旧数据', onClick: () => finish('abort', '正在取消迁移并恢复旧数据…') }
      })
    } else if (state.view === 'result') {
      const committed = state.result && state.result.phase === 'committed'
      renderActions({
        start: committed ? { label: '启动网关', onClick: startGateway } : null,
        alt: committed ? { label: '回退这次迁移', onClick: () => finish('rollback', '正在核对并回退这次迁移…') } : { label: '重新检查', onClick: restart }
      })
    } else {
      renderActions({})
    }
  }
  function renderStepBadge() {
    const labels = { loading: '正在查找', source: '选择旧数据', gallery: '处理图片', review: '核对内容', running: '正在迁移', result: '已完成', recovery: '待收尾' }
    el('step-badge').textContent = labels[state.view] || '准备中'
    el('step-badge').className = state.view === 'result' && state.result && state.result.phase !== 'committed' ? 'badge failed' : 'badge'
  }
  // 扫描结果自己会说话：有几处、在哪、多大。一个都没有时，下面的手动表单就是出路。
  function renderSourceLede() {
    const count = state.candidates.filter(candidate => !candidate.manual).length
    const lede = el('source-lede')
    lede.hidden = count === 0
    if (count) lede.textContent = `在这台电脑上找到 ${count} 处旧版数据。选中一份后开始迁移；不再需要的也可以直接删除。`
    el('source-empty').hidden = count > 0
  }
  function renderCandidates() {
    const list = el('candidates')
    list.replaceChildren()
    renderSourceLede()
    state.candidates.forEach((candidate, index) => {
      const row = document.createElement('label')
      row.className = state.selected === candidate ? 'choice selected' : 'choice'
      const input = document.createElement('input')
      input.type = 'radio'
      input.name = 'migration-candidate'
      input.value = String(index)
      input.checked = state.selected === candidate
      input.onchange = () => {
        state.selected = candidate
        state.galleryChoice = candidate.galleryFiles ? 'import' : 'skip'
        notice('')
        renderCandidates()
        render()
      }
      const note = candidate.autoImport ? '可以直接迁移' : (reviewNotes[candidate.review] || '需要人工核对')
      const body = document.createElement('span')
      body.append(Object.assign(document.createElement('b'), { textContent: kindLabel(candidate.sourceKind) }))
      body.appendChild(document.createElement('code')).textContent = candidate.sourceRoot
      body.append(Object.assign(document.createElement('small'), {
        textContent: candidate.manual
          ? '手动指定的目录，内容待检查'
          : `${candidate.files} 个数据文件 · ${candidate.galleryFiles} 张图片 · 约 ${mb(candidate.bytes)} MB`
      }))
      const flag = document.createElement('em')
      flag.className = candidate.autoImport ? 'flag ok' : 'flag warn'
      flag.textContent = candidate.manual ? '待检查' : note
      body.append(flag)
      row.append(input, body)
      list.append(row)
    })
  }
  function renderSummary() {
    const list = el('summary-list')
    list.replaceChildren()
    const rows = []
    if (!state.plan) rows.push(['迁移内容', '正在核对…'])
    else {
      const p = state.plan
      rows.push(['迁移内容', `${p.files} 个数据文件`])
      rows.push(['生成图片', p.galleryFiles ? `${p.galleryFiles} 张（一起复制，原图库保留）` : '本次不迁移图片'])
      rows.push(['占用空间', `约 ${mb(p.bytes)} MB`])
      rows.push(['迁移方式', p.inPlace ? '就在原地升级，不需要复制' : '复制到桌面版工作空间'])
      rows.push(['来源位置', state.selected.sourceRoot])
      rows.push(['数据位置', state.context ? state.context.targetRoot : '—'])
      if (p.externalPathCount) rows.push(['外部路径', `${p.externalPathCount} 项需要你确认后另行处理`])
    }
    for (const [name, value] of rows) {
      list.append(Object.assign(document.createElement('dt'), { textContent: name }))
      list.append(Object.assign(document.createElement('dd'), { textContent: value }))
    }
  }
  function renderAutoNotice(migration) {
    const box = el('auto')
    if (!migration || migration.state === 'none') { box.hidden = true; return }
    box.hidden = false
    box.className = migration.state === 'imported' ? 'notice ok' : 'notice'
    if (migration.state === 'imported') {
      box.textContent = `已经把 ${migration.sourceRoot} 里的 ${migration.files} 个数据文件、${migration.galleryFiles} 张图片搬进来了，备份已保留。下面可以继续查看备份或回退。`
    } else {
      box.textContent = reviewNotes[migration.reason] || describe(migration.reason)
    }
  }

  // ---- 流程 -----------------------------------------------------------------
  // 每一步都必须显式 setView：少一次调用用户就停在上一屏，而 DOM 里的控件全都
  // 还在（hidden 的只是容器），肉眼很难发现，只有真正点一遍才看得出来。
  function go(view) {
    state.view = view
    setView(view)
    if (view === 'source') { setStep('source'); renderCandidates(); render(); return }
    if (view === 'gallery') {
      setStep('gallery')
      // 单选框要跟着状态走，否则界面上勾的是「一起迁移」而状态里还是「跳过」。
      for (const node of document.querySelectorAll('input[name="migration-gallery"]')) node.checked = node.value === state.galleryChoice
      const count = state.selected.galleryFiles
      el('gallery-lede').textContent = count === GALLERY_COUNT_UNKNOWN
        ? `要一并迁移 ${state.selected.galleryRoot} 里的图片吗？`
        : `这个位置里还有 ${count} 张生成的图片，要一起搬过来吗？`
      render(); return
    }
    if (view === 'review') { setStep('review'); plan(); return }
    render()
  }
  function next() {
    if (state.view === 'source') {
      if (!hasGallery()) state.galleryChoice = 'skip'
      return go(hasGallery() ? 'gallery' : 'review')
    }
    return go('review')
  }
  async function loadContext() {
    if (state.loading || state.busy) return
    state.loading = true
    setView('loading')
    render()
    try {
      state.context = await invoke({ operation: 'context' })
      renderError('')
      await loadCandidates()
    } catch (error) {
      renderError(describe(error), error)
      state.loading = false
      setView('source'); renderCandidates(); render()
      return
    }
    state.loading = false
    if (state.context.pending) {
      state.view = 'recovery'
      setView('recovery')
      renderRecovery()
      render()
      return
    }
    go('source')
  }
  async function loadCandidates() {
    try {
      const found = await invoke({ operation: 'detect' })
      state.candidates = found.candidates || []
      if (!state.selected) {
        // 只有一个候选时直接选中：多数人只有一份旧数据，这一步不该需要思考。
        state.selected = state.candidates.length === 1 ? state.candidates[0] : null
        state.galleryChoice = state.selected && state.selected.galleryFiles ? 'import' : 'skip'
      }
    } catch (error) {
      state.candidates = []
      renderError(describe(error), error)
    }
  }
  function selectionOf(candidate) {
    const pathMappings = {}
    const auth = el('auth-map').value.trim()
    const reference = el('reference-map').value.trim()
    if (auth) pathMappings.authFilePath = auth
    if (reference) pathMappings.referenceRoot = reference
    return {
      sourceRoot: candidate.sourceRoot,
      sourceKind: candidate.sourceKind,
      galleryRoot: state.galleryChoice === 'import' ? candidate.galleryRoot || null : null,
      keepExternalPaths: el('external').checked,
      ...(Object.keys(pathMappings).length ? { pathMappings } : {})
    }
  }
  // 需要人工核对外部路径时，把逃生口直接摊开；不需要时它就该默默收着。
  function syncAdvanced(error) {
    const needsPathReview = ['MIGRATION_PATH_REVIEW_REQUIRED', 'MIGRATION_EXTERNAL_PATH_REVIEW_REQUIRED', 'MIGRATION_PATH_NOT_COPIED'].includes(String(error))
    el('advanced').open = needsPathReview || Boolean(state.plan && state.plan.externalPathCount)
  }
  async function plan() {
    setView('review')
    setStep('review')
    state.plan = null
    // 核对是一个网络往返，期间必须让界面明确处在「还在算」的状态：否则按钮看起来
    // 可点而内部计划是空的，点了没有任何反馈（这是迁移里最糟糕的一类失败）。
    setPlanning(true)
    renderSummary()
    render()
    renderError('')
    try {
      state.plan = await invoke({ operation: 'plan', selection: selectionOf(state.selected) })
    } catch (error) {
      // 核对失败就把人送回能改的那一步：停在空的核对页上，用户只能自己猜该改哪里。
      state.plan = null
      setPlanning(false)
      renderError(describe(error), error)
      syncAdvanced(error)
      go(hasGallery() ? 'gallery' : 'source')
      return
    }
    setPlanning(false)
    syncAdvanced()
    renderSummary()
    render()
  }
  // 计划是否算好了，唯一的外部可见信号。按钮的 disabled 同时受「未勾选确认」影响，
  // 不能拿来代替这个状态。
  function setPlanning(value) {
    state.planning = value
    // 复用 loading：核对期间不该再触发一次自动扫描，否则用户选中的候选会被冲掉。
    state.loading = value
    views.review.dataset.planning = value ? 'true' : 'false'
  }
  async function apply() {
    // 缺什么就说缺什么：静默 return 会让用户以为点了没反应，而迁移按钮不能乱点第二次。
    if (state.planning) return
    if (!el('stopped').checked) { renderError(describe('MIGRATION_STOP_CONFIRMATION_REQUIRED')); return }
    if (!state.plan) { renderError(describe('MIGRATION_PLAN_REQUIRED')); return }
    // 后端已经记住了这次核对过的计划，迁移只认指纹：多带一个 selection 会被直接拒掉。
    await run({
      operation: 'apply', fingerprint: state.plan.fingerprint, sourceStopped: true
    }, '正在备份、核对并迁移…')
  }
  async function finish(operation, label) {
    await run({ operation, sourceStopped: true }, label)
  }
  async function run(request, label) {
    if (state.busy || state.loading) return
    state.busy = true
    setView('running')
    el('running-text').textContent = label
    renderError('')
    render()
    try {
      const result = await invoke(request)
      state.result = result
      state.selected = state.context = state.plan = null
      state.candidates = []
      state.view = 'result'
      setStep('done')
      el('result-title').textContent = result.phase === 'committed' ? '迁移完成' : '已取消，旧数据保持原样'
      el('result-text').textContent = result.phase === 'committed'
        ? '账号、配置和图片都已经搬进桌面版工作空间。旧目录和备份都保留着，随时可以回退。'
        : '没有做任何改动。旧目录还在原来的位置，可以稍后重新开始。'
      const archive = el('archive')
      archive.hidden = !result.archive
      if (result.archive) archive.textContent = result.archive
      setView('result')
    } catch (error) {
      renderError(describe(error), error)
      state.selected = state.context = state.plan = null
      setView('source')
      await loadCandidatesQuiet()
    } finally {
      state.busy = false
      el('stopped').checked = false
      render()
    }
  }
  async function loadCandidatesQuiet() {
    try {
      const found = await invoke({ operation: 'detect' })
      state.candidates = found.candidates || []
      state.selected = state.candidates.length === 1 ? state.candidates[0] : null
    } catch { /* 候选列表失败不覆盖上面的错误提示 */ }
    renderCandidates()
  }

  // ---- 删除旧数据 -------------------------------------------------------------
  // 迁移永远不删除旧目录；删除是用户对「不需要的旧数据」的显式选择，必须经过确认。
  function notice(text) {
    const box = el('source-notice')
    box.hidden = !text
    box.textContent = text || ''
  }
  function discardSelected() {
    const candidate = state.selected
    if (!candidate || candidate.manual || state.busy || state.loading) {
      if (candidate && candidate.manual) renderError(describe('MIGRATION_SOURCE_NOT_DETECTED'), 'MIGRATION_SOURCE_NOT_DETECTED')
      return
    }
    window.confirmAction(null, '删除这份旧数据？',
      `${candidate.sourceRoot} 里的账号、配置和图片会被永久删除，无法恢复。如果只是想搬进桌面版，请用「下一步」迁移。`,
      '永久删除', () => discard(candidate))
  }
  async function discard(candidate) {
    if (state.busy || state.loading) return
    state.busy = true
    setView('running')
    el('running-text').textContent = '正在删除这份旧数据…'
    renderError('')
    render()
    try {
      const result = await invoke({ operation: 'discard', sourceRoot: candidate.sourceRoot })
      state.selected = null
      state.view = 'source'
      setView('source')
      setStep('source')
      renderError('')
      notice(`已删除 ${result.discarded}。`)
      await loadCandidatesQuiet()
    } catch (error) {
      state.view = 'source'
      setView('source')
      setStep('source')
      renderError(describe(error), error)
      await loadCandidatesQuiet()
    } finally {
      state.busy = false
      render()
    }
  }
  function renderRecovery() {
    const recovery = state.context && state.context.recovery
    // 「还原」对谨慎用户是有破坏暗示的词，必须讲清丢的是什么、不丢的是什么。
    const head = recovery
      ? `来源：${recovery.sourceRoot}。上次记录了 ${recovery.files} 个数据文件、${recovery.galleryFiles} 张图片。`
      : '上一次迁移留下了未完成的记录。'
    el('recovery-summary').textContent =
      `${head}继续会核对上次的备份后完成迁移；取消则会丢弃这次已经复制的内容、把旧目录恢复到迁移前的样子。两种都不会删除旧目录，也不会删除已有备份。`
  }
  async function startGateway() {
    try { await window.__TAURI__.core.invoke('gateway_action', { action: 'retry' }) }
    catch (error) { renderError(describe(error), error) }
  }
  function restart() {
    state.result = null
    state.selected = null
    loadContext()
  }

  // ---- 手动指定 -------------------------------------------------------------
  el('manual-use').onclick = () => {
    const sourceRoot = el('source').value.trim()
    const manualError = el('manual-error')
    if (!sourceRoot) {
      manualError.textContent = '请先填写完整目录路径。'
      return
    }
    manualError.textContent = ''
    notice('')
    const gallery = el('gallery').value.trim()
    const manual = {
      sourceRoot,
      sourceKind: el('kind').value,
      galleryRoot: gallery || null,
      files: 0,
      galleryFiles: gallery ? GALLERY_COUNT_UNKNOWN : 0,
      bytes: 0,
      manual: true
    }
    state.selected = manual
    // 填了图库目录就默认一起迁移：这是用户刚刚明确给出的意图，不能沿用
    // 上一次自动扫描留下的「跳过」。
    state.galleryChoice = gallery ? 'import' : 'skip'
    state.candidates = [manual, ...state.candidates.filter(candidate => !candidate.manual)]
    renderCandidates()
    render()
  }
  el('source').addEventListener('input', () => { el('manual-error').textContent = '' })
  for (const node of document.querySelectorAll('input[name="migration-gallery"]')) {
    node.onchange = () => { state.galleryChoice = node.value }
  }
  el('stopped').onchange = render
  el('stop-service').onclick = async () => {
    try { await window.__TAURI__.core.invoke('gateway_action', { action: 'maintenance' }) }
    catch (error) { renderError(describe(error), error) }
  }
  // 改了外部路径的处理方式等于换了一份迁移计划，必须重新核对指纹。
  el('advanced-apply').onclick = () => { if (state.selected) plan() }

  window.migrationWizard = {
    refreshAfterRestore() {
      state.result = null
      state.selected = null
      state.plan = null
      loadContext()
    },
    update(gateway, migration) {
      // 「维护模式」= 服务已停下、可以动数据，这正是迁移与备份的时机，不能把卡片藏起来。
      // 「review」= 自动迁移发现了旧数据但不敢替用户决定：这时候不显示，用户就永远不知道
      // 这份数据存在，人工迁移这条路等于不存在。
      const visible = ['setup', 'migrating', 'migration_complete', 'maintenance'].includes(gateway.phase)
        || ['DATA_MIGRATION_REQUIRED', 'DATA_MIGRATION_PENDING'].includes(gateway.code)
        || (migration && ['imported', 'review'].includes(migration.state))
      el('panel').hidden = !visible
      document.body.classList.toggle('migration-mode', visible)
      renderAutoNotice(migration)
      // 网关在跑的时候，连「读一眼当前状态」都会被后端拒绝：迁移要重写整个数据目录。
      // 这时候不该去碰任何 IPC（会刷一屏红字），而是把「为什么不能动 + 怎么继续」摆出来。
      const running = RUNNING_PHASES.includes(gateway.phase)
      el('service-notice').hidden = !visible || !running
      document.getElementById('migration-views').hidden = running
      const revision = `${gateway.phase}|${gateway.code}|${migration ? migration.state : ''}`
      // 重载只发生在「这个界面还没被用起来」的时候。任何一次核对或迁移都会把网关
      // 阶段切成 migrating 再切回来 —— 若按阶段变化就重载，用户选好的候选、勾选项
      // 和刚算出来的计划会在半路被整个冲掉，看起来就是「点了又跳回第一步」。
      const idle = !state.selected && !state.busy && !state.loading && state.view !== 'result'
      if (visible && !running && idle && (!state.lastVisible || revision !== state.lastCode)) loadContext()
      state.lastVisible = visible
      state.lastCode = revision
    }
  }
})()
