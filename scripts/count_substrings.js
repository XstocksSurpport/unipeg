import fs from 'node:fs'

const path =
  process.argv[2] ??
  'C:/Users/TZH/.cursor/projects/c-Users-TZH-Desktop-unipeg/agent-tools/cbfda24a-cafb-4fc4-a05f-596c3f75dadd.txt'
const text = fs.readFileSync(path, 'utf8')

for (const needle of ['/positions', 'positionId', 'upegIds', '`/upeg']) {
  const count = text.split(needle).length - 1
  console.log(needle, count)
}
