import fs from 'node:fs'

const path =
  process.argv[2] ??
  'C:/Users/TZH/.cursor/projects/c-Users-TZH-Desktop-unipeg/agent-tools/cbfda24a-cafb-4fc4-a05f-596c3f75dadd.txt'

const text = fs.readFileSync(path, 'utf8')
const re = /https?:\/\/[^"'\s)]+/g
const urls = [...text.matchAll(re)].map((m) => m[0])
const uniq = [...new Set(urls)].filter((u) => /peg2peg|p2peg|\/api/i.test(u))
console.log(uniq.join('\n'))
console.error('total', uniq.length)
