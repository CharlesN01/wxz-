"""Execute one command with a dotenv-compatible environment file.

The file is parsed as data rather than sourced by a shell. This keeps values
containing dollar signs, quotes, or command-like text from being evaluated.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from dotenv import dotenv_values


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print("usage: run_with_env.py ENV_FILE COMMAND [ARG ...]", file=sys.stderr)
        return 2

    env_path = Path(argv[1])
    if not env_path.is_file():
        print(f"environment file not found: {env_path}", file=sys.stderr)
        return 2

    values = dotenv_values(env_path, interpolate=False)
    environment = os.environ.copy()
    for key, value in values.items():
        if key and value is not None:
            environment[key] = value

    command = argv[2:]
    os.execvpe(command[0], command, environment)
    return 127


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
