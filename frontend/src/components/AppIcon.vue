<script setup>
defineProps({name:{type:String,default:'overview'}})
const paths={
 overview:'M3 3h7v7H3zM14 3h7v4h-7zM14 11h7v10h-7zM3 14h7v7H3z',
 account:'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21v-2a7 7 0 0 1 14 0v2M19 4h3m-1.5-1.5v3',
 images:'M3 4h18v16H3zM3 15l5-5 5 5 3-3 5 5M15 8h.01',
 models:'m12 2 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 17l9 5 9-5',
 apikeys:'M14 9a5 5 0 1 1-3-4M11 10 3 18v3h3v-3h3v-3l3-3M17 5h.01',
 logs:'M5 3h14v18H5zM8 7h8M8 11h5M8 15h8M8 18h4',
 service:'M3 5h18v5H3zM3 14h18v5H3zM6 7.5h.01M6 16.5h.01M15 7.5h3M15 16.5h3',
 data:'M20 6c0 2-16 2-16 0s16-2 16 0ZM4 6v12c0 3 16 3 16 0V6M4 12c0 3 16 3 16 0',
 settings:'M4 7h16M4 17h16M9 4v6M15 14v6',
 chevron:'m9 6 6 6-6 6'
}
</script>
<template><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="paths[name] || paths.overview"/></svg></template>
