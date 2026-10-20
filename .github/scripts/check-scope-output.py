"""Refuse absent or malformed outputs before a scope job can succeed."""

import json
import os

OUTPUTS = ("lint", "typecheck", "root", "web", "signaling", "integration", "notices", "test", "relay", "relay_soak", "macos")


def validate(values):
    if set(values) != set(OUTPUTS) or any(values[key] not in ("true", "false") for key in OUTPUTS):
        raise ValueError("Scope outputs must all be explicit true/false values")
    if values["relay_soak"] == "true" and values["relay"] != "true":
        raise ValueError("Relay soak requires short relay controls")


if __name__ == "__main__":
    validate({key: os.environ.get(f"CI_SCOPE_{key.upper()}") for key in OUTPUTS})
    print(json.dumps({"mandatory_scope_outputs": "pass"}))
