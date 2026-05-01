import fs from 'node:fs'

const path =
  process.argv[2] ??
  'C:/Users/TZH/.cursor/projects/c-Users-TZH-Desktop-unipeg/agent-tools/cbfda24a-cafb-4fc4-a05f-596c3f75dadd.txt'
const needle = process.argv[3] ?? 'upegIds'
const text = fs.readFileSync(path, 'utf8')

let idx = text.indexOf(needle)
let count = 0
while (idx !== -1 && count < 6) {
  console.log('---', count, '---')
  console.log(text.slice(Math.max(0, idx - 160), idx + 260))
  idx = text.indexOf(needle, idx + needle.length)
  count += 1
}
