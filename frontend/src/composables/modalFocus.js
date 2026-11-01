// Shared keyboard behavior for mounted dialogs; closing retains each owner's policy.
const states = new WeakMap()
const candidates = 'button, input, select, textarea, a[href], [tabindex]'
function focusable(root) {
  return [...root.querySelectorAll(candidates)].filter(el => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden')
}
export const vModalFocus = {
  mounted(el, binding) {
    const state = { previous: document.activeElement, close: binding.value }
    states.set(el, state)
    el.tabIndex = -1
    const focusFirst = () => (focusable(el)[0] || el).focus()
    state.key = event => {
      if (event.key === 'Escape' && !event.isComposing) {
        event.preventDefault(); event.stopPropagation(); state.close?.()
      } else if (event.key === 'Tab') {
        const items = focusable(el), first = items[0], last = items.at(-1)
        if (!first) { event.preventDefault(); el.focus() }
        else if (event.shiftKey && (document.activeElement === first || document.activeElement === el)) { event.preventDefault(); last.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
      }
    }
    state.focus = event => { if (!el.contains(event.target)) focusFirst() }
    el.addEventListener('keydown', state.key)
    document.addEventListener('focusin', state.focus)
    focusFirst()
  },
  updated(el, binding) {
    states.get(el).close = binding.value
    if (!el.contains(document.activeElement)) (focusable(el)[0] || el).focus()
  },
  unmounted(el) {
    const state = states.get(el)
    document.removeEventListener('focusin', state.focus)
    el.removeEventListener('keydown', state.key)
    if (state.previous?.isConnected) state.previous.focus()
    states.delete(el)
  }
}
