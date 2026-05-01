import json
import sys
from pathlib import Path


def main() -> None:
    dump_path = Path(sys.argv[1])
    names = sys.argv[2:]
    text = dump_path.read_text(encoding="utf-8", errors="ignore")
    abi_line = next(line for line in text.splitlines() if line.strip().startswith('[{"inputs"'))
    abi = json.loads(abi_line)
    for name in names:
        fn = next(item for item in abi if item.get("type") == "function" and item["name"] == name)
        print(json.dumps(fn, indent=2))


if __name__ == "__main__":
    main()
