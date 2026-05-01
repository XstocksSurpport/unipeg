import json
import sys
from pathlib import Path


def main() -> None:
    dump_path = Path(sys.argv[1] if len(sys.argv) > 1 else r"C:\Users\TZH\.cursor\projects\c-Users-TZH-Desktop-unipeg\agent-tools\de19cb3e-cd00-40ed-b6b1-14a49f17ef07.txt")
    text = dump_path.read_text(encoding="utf-8", errors="ignore")
    lines = text.splitlines()
    abi_line = next(line for line in lines if line.strip().startswith('[{"inputs"'))
    abi = json.loads(abi_line)
    functions = [item for item in abi if item.get("type") == "function"]
    names = sorted({fn["name"] for fn in functions})
    print(len(names))
    for name in names:
        print(name)


if __name__ == "__main__":
    main()
