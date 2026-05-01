import fs from 'node:fs'

const needle = process.argv[2] ?? 'async function gA'
const path = 'C:/Users/TZH/.cursor/projects/c-Users-TZH-Desktop-unipeg/agent-tools/cbfda24a-cafb-4fc4-a05f-596c3f75dadd.txt'
const text = fs.readFileSync(path, 'utf8')
const idx = text.indexOf(needle)
console.log('index', idx)
console.log(text.slice(idx, idx + 800))
