<script setup>
import { computed } from 'vue'
import { parseBase } from '../api/client'
import BrandMark from './BrandMark.vue'
import AppIcon from './AppIcon.vue'
import { isDesktopWorkspace, openDesktopWorkspace } from '../desktopWorkspace'
defineProps({active:{type:String,default:'overview'},gwRunning:Boolean,connected:Boolean,collapsed:Boolean})
const emit=defineEmits(['navigate','toggle'])
const endpoint=computed(()=>{const {host,port}=parseBase();return `${host}:${port}`})
const groups=[
 {label:'工作区',items:[{key:'overview',label:'概览'},{key:'account',label:'账号管理'},{key:'images',label:'图片素材'},{key:'models',label:'模型能力'}]},
 {label:'开发接入',items:[{key:'apikeys',label:'API Key'},{key:'logs',label:'调用日志'}]},
 {label:'管理',items:[...(isDesktopWorkspace()?[{key:'service',label:'服务与诊断',native:true},{key:'data',label:'数据与备份',native:true}]:[]),{key:'settings',label:'设置'}]}
]
function navigate(item){if(item.native)openDesktopWorkspace(item.key);else emit('navigate',item.key)}
</script>
<template>
 <aside class="sidebar" :class="{collapsed}">
  <div class="logo"><BrandMark class="logo-mark"/><div v-if="!collapsed" class="logo-copy"><strong>Codex 网关</strong><small>AI WORKSPACE</small></div><button class="collapse-btn" :title="collapsed?'展开侧栏':'收起侧栏'" :aria-label="collapsed?'展开侧栏':'收起侧栏'" @click="emit('toggle')"><AppIcon name="chevron" :class="{reverse:!collapsed}"/></button></div>
  <nav class="nav" aria-label="工作台导航"><div v-for="group in groups" :key="group.label" class="nav-group"><div v-if="!collapsed" class="nav-label">{{group.label}}</div><button v-for="item in group.items" :key="item.key" :data-workspace-page="item.key" class="nav-item" :class="{active:active===item.key}" :title="item.label" :aria-label="item.label" :aria-current="active===item.key?'page':undefined" @click="navigate(item)"><AppIcon :name="item.key"/><span v-if="!collapsed">{{item.label}}</span></button></div></nav>
  <div class="status-box" :title="'模型代理 · '+(!connected?'等待连接':gwRunning?'运行中':'未启动')"><span class="status-dot" :class="{unknown:!connected,off:connected&&!gwRunning}"></span><div v-if="!collapsed"><div class="status-label">模型代理 · {{!connected?'等待连接':gwRunning?'运行中':'未启动'}}</div><div class="status-meta">{{endpoint}}</div></div></div>
 </aside>
</template>
<style scoped>
.sidebar{width:232px;flex-shrink:0;background:var(--sidebar);border-right:1px solid var(--border);display:flex;flex-direction:column;padding:20px 12px 12px;transition:width .2s ease;min-height:0}
.logo{display:flex;align-items:center;gap:10px;padding:0 6px 22px}.logo-mark{width:36px;height:36px;flex-shrink:0;color:var(--primary)}.logo-copy{flex:1;min-width:0}.logo-copy strong{display:block;font-size:14px;white-space:nowrap}.logo-copy small{display:block;letter-spacing:.12em;font-size:9px;color:var(--text-3);margin-top:3px}
.collapse-btn{border:0;background:transparent;color:var(--text-3);width:22px;height:26px;padding:3px;border-radius:6px;cursor:pointer}.collapse-btn svg{width:16px;height:16px}.reverse{transform:rotate(180deg)}
.nav{display:flex;flex-direction:column;gap:19px;overflow-y:auto;min-height:0}.nav-group{display:flex;flex-direction:column;gap:3px}.nav-label{font-size:10px;letter-spacing:.08em;color:var(--text-3);padding:0 12px 6px}.nav-item{display:flex;align-items:center;gap:11px;padding:10px 12px;border:0;border-radius:9px;min-height:39px;background:transparent;color:var(--text-2);text-align:left;font-size:12.5px;cursor:pointer;white-space:nowrap}.nav-item svg{width:18px;height:18px;flex-shrink:0}.nav-item:hover{background:var(--card-2);color:var(--text)}.nav-item.active{background:var(--primary-soft);color:var(--primary);font-weight:650}
.status-box{margin-top:auto;padding:12px 10px 0;display:flex;align-items:center;gap:9px;border-top:1px solid var(--border)}.status-label{font-size:10px}.status-meta{font-size:10px;font-family:var(--mono);color:var(--text-3);margin-top:3px}.status-dot{width:7px;height:7px;background:var(--primary);flex:none;animation:none}.status-dot.unknown{background:var(--text-3)}.status-dot.off{background:var(--rose)}
.sidebar.collapsed{width:64px;padding:18px 8px 12px}.collapsed .logo{flex-direction:column;padding:0 0 18px;gap:6px}.collapsed .nav-item{justify-content:center;padding:10px 0}.collapsed .status-box{justify-content:center;padding:12px 0 0}.collapsed .nav{gap:16px}
@media(max-width:520px){.sidebar.collapsed{width:56px;padding-left:6px;padding-right:6px}.logo-mark{width:30px;height:30px}}
</style>
