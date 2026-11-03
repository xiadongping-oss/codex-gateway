import { ref } from 'vue'
import { isDesktopWorkspace } from '../desktopWorkspace'

const native = window.__CGW_APPEARANCE__
const system = window.matchMedia('(prefers-color-scheme: dark)')
const preference = ref(native?.appearance || localStorage.getItem('cgw.theme') || 'light')
const resolve = value => value === 'system' ? (system.matches ? 'dark' : 'light') : value === 'dark' ? 'dark' : 'light'
const theme = ref(native?.resolvedAppearance || resolve(preference.value))
const themeError = ref('')
function paint(value) { theme.value = value; document.documentElement.dataset.theme = value }
paint(theme.value)
window.addEventListener('cgw:appearance', event => {
  preference.value = event.detail.appearance
  paint(event.detail.resolvedAppearance)
  themeError.value = ''
})
window.addEventListener('cgw:preference-error', event => { themeError.value = event.detail || '外观未能保存。' })
system.addEventListener('change', () => { if (preference.value === 'system') paint(resolve('system')) })
function setTheme(value) {
  if (!['light','dark','system'].includes(value)) return
  preference.value = value; themeError.value = ''; paint(resolve(value))
  if (isDesktopWorkspace()) window.location.href = `cgw-workspace://appearance/${value}`
  else localStorage.setItem('cgw.theme', value)
}
export function useTheme() { return { theme, themeError, preference, setTheme, toggleTheme: () => setTheme(theme.value === 'dark' ? 'light' : 'dark') } }
