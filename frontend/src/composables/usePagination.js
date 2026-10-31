import { computed, ref, watch } from 'vue'
export function usePagination(items, size = 24) {
 const page=ref(1)
 const pages=computed(()=>Math.max(1,Math.ceil(items.value.length/size)))
 watch(pages,n=>{page.value=Math.min(page.value,n)})
 const visible=computed(()=>items.value.slice((page.value-1)*size,page.value*size))
 return {page,pages,visible}
}
