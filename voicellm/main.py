#!/usr/bin/env python3
"""Dev convenience entry point — run from a repo checkout without installing.

Installed users should use the `voxagent` console script instead
(see voxagent/cli.py).
"""

from voxagent.cli import main

if __name__ == "__main__":
    main()
