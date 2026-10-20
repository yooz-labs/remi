#!/usr/bin/env python3
"""Copy the installed production module closure without resolving new package versions."""

import argparse
import json
import shutil
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


def locate(start, name):
    for base in (start, *start.parents):
        candidate = (
            base / name if base.name == "node_modules" else base / "node_modules" / name
        )
        if (candidate / "package.json").is_file():
            return candidate.resolve()
    raise FileNotFoundError(name)


def prepare(output):
    output.mkdir(parents=True, exist_ok=False)
    modules = {}
    versions = {}

    def copy(source, destination, trail=()):
        source = source.resolve()
        if source in trail:
            raise ValueError("Dependency cycle requires an explicit captured layout")
        package = json.loads((source / "package.json").read_text())
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(
            source,
            destination,
            ignore=lambda folder, names: (
                ["node_modules"]
                if Path(folder) == source and "node_modules" in names
                else []
            ),
        )
        modules[str(destination.relative_to(output))] = {
            "version": package["version"],
            "source": str(source),
        }
        for name in package.get("dependencies", {}):
            if name == "@remi/shared":
                continue  # The source snapshot and tsconfig path own this workspace import.
            try:
                child = locate(source, name)
            except FileNotFoundError:
                if name in package.get("optionalDependencies", {}):
                    continue
                raise
            copy(child, destination / "node_modules" / name, (*trail, source))

    dependencies = json.loads((REPO / "packages/daemon/package.json").read_text())[
        "dependencies"
    ]
    for name in dependencies:
        if name == "@remi/shared":
            continue
        source = locate(REPO / "packages/daemon", name)
        versions[name] = json.loads((source / "package.json").read_text())["version"]
        copy(source, output / name)
    if any(entry.is_symlink() for entry in output.rglob("*")):
        raise ValueError("Prepared dependency snapshot contains a symlink")
    manifest = {"rootVersions": versions, "modules": modules}
    output.with_name(output.name + "-manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n"
    )
    return {"rootVersions": versions, "moduleCopies": len(modules), "symlinks": 0}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(prepare(args.out)))
