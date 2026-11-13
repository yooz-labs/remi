"""Reuse only an actual same-PR soak with unchanged protected policy (#1206)."""

import argparse
import hashlib
import io
import json
import os
import re
import runpy
import subprocess
import time
import urllib.parse
import zipfile
from pathlib import Path

WORKFLOW = ".github/workflows/relay-r7.yml"
SHORT = "Existing actual wire and authority controls"
SOAK = "Same attached session for 61 actual minutes"
MAX_ARCHIVE = 8 * 1024 * 1024
FIELDS = {
    "repository",
    "repository_id",
    "pr",
    "branch",
    "base",
    "head",
    "checkout",
    "tree",
    "parents",
    "kind",
    "policy",
    "environment",
    "run",
    "attempt",
    "workflow_id",
}


class Ineligible(ValueError):
    """An expected cache miss preserves the original gate, never grants reuse."""


def require(condition, reason):
    if not condition:
        raise Ineligible(reason)


def unique(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "duplicate JSON field")
        result[key] = value
    return result


def decode(raw):
    require(len(raw) <= 2 * 1024 * 1024, "oversized API JSON")
    return json.loads(raw, object_pairs_hook=unique)


def git(*args):
    return (
        subprocess.check_output(["git", *args], stderr=subprocess.PIPE).decode().strip()
    )


def digest(value):
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def context(protected=True):
    require(os.environ.get("GITHUB_EVENT_NAME") == "pull_request", "non-PR event")
    require(not any(key.startswith("GIT_") for key in os.environ), "Git override")
    require(
        os.environ.get("GITHUB_SERVER_URL") == "https://github.com"
        and os.environ.get("GITHUB_API_URL") == "https://api.github.com",
        "unknown API host",
    )
    source = Path(os.environ["GITHUB_EVENT_PATH"])
    require(source.stat().st_size <= 1024 * 1024, "oversized event")
    event = decode(source.read_bytes())
    pr, repo = event["pull_request"], event["repository"]
    slug = os.environ["GITHUB_REPOSITORY"]
    require(
        os.environ.get("GITHUB_JOB") == "local-relay"
        and os.environ.get("GITHUB_WORKFLOW_REF", "").startswith(
            f"{slug}/{WORKFLOW}@refs/"
        ),
        "workflow job context",
    )
    require(
        re.fullmatch(r"[\w.-]+/[\w.-]+", slug) and repo["full_name"] == slug,
        "repository mismatch",
    )
    require(
        type(repo["id"]) is int
        and str(repo["id"]) == os.environ["GITHUB_REPOSITORY_ID"],
        "repository ID",
    )
    require(
        pr["head"]["repo"]["id"] == repo["id"] == pr["base"]["repo"]["id"],
        "fork context",
    )
    base, head, checkout = (
        pr["base"]["sha"],
        pr["head"]["sha"],
        os.environ["GITHUB_SHA"],
    )
    require(
        all(re.fullmatch(r"[0-9a-f]{40}", ref) for ref in (base, head, checkout)),
        "commit IDs",
    )
    require(
        Path.cwd().resolve() == Path(os.environ["GITHUB_WORKSPACE"]).resolve()
        and git("rev-parse", "HEAD") == checkout
        and git("rev-parse", "--is-shallow-repository") == "false",
        "unknown or shallow checkout",
    )
    require(not git("status", "--porcelain", "--untracked-files=no"), "dirty checkout")
    parents = git("rev-list", "--parents", "-n", "1", checkout).split()[1:]
    kind = "head" if checkout == head else "merge"
    require(kind == "head" or parents == [base, head], "advanced or unknown merge base")
    policy = runpy.run_path(str(Path(__file__).with_name("ci-scope.py")))
    inventory = policy["validation_inventory"](checkout)
    require(policy["validation_inventory"](head) == inventory, "head policy drift")
    if protected:
        require(
            policy["validation_inventory"](base) == inventory,
            "policy not landed at protected base",
        )
        require(
            policy["validation_needed"]()["validation_required"] is False,
            "checkout or protected validation context unavailable",
        )
    contents = policy["validation_objects"](
        dict.fromkeys((blob for _, blob in inventory.values()), "blob")
    )
    for name, (mode, blob) in inventory.items():
        path = Path(name)
        require(
            not path.is_symlink()
            and path.resolve() == Path.cwd() / path
            and path.is_file(),
            "policy path",
        )
        require(
            path.read_bytes() == contents[blob]
            and ("100755" if path.stat().st_mode & 0o111 else "100644") == mode,
            "policy working bytes",
        )
    environment = {
        key: os.environ.get(key)
        for key in ("RUNNER_OS", "RUNNER_ARCH", "ImageOS", "ImageVersion")
    }
    environment["bun"] = (
        subprocess.check_output(["bun", "--version"], stderr=subprocess.PIPE)
        .decode()
        .strip()
    )
    require(
        environment["bun"] == os.environ.get("BUN_VERSION") == "1.4.2", "Bun identity"
    )
    require(
        all(
            isinstance(value, str) and re.fullmatch(r"[\w.+-]{1,100}", value)
            for value in environment.values()
        ),
        "runner identity unavailable",
    )
    result = {
        "repository": slug,
        "repository_id": repo["id"],
        "pr": pr["number"],
        "branch": pr["head"]["ref"],
        "base": base,
        "head": head,
        "checkout": checkout,
        "tree": git("rev-parse", f"{checkout}^{{tree}}"),
        "parents": parents,
        "kind": kind,
        "policy": digest(inventory),
        "environment": environment,
        "run": int(os.environ["GITHUB_RUN_ID"]),
        "attempt": int(os.environ["GITHUB_RUN_ATTEMPT"]),
    }
    require(
        type(result["pr"]) is int
        and result["pr"] > 0
        and result["run"] > 0
        and result["attempt"] > 0,
        "run or PR identity",
    )
    return result


def archive_receipt(raw, artifact):
    require(
        0 < len(raw) <= MAX_ARCHIVE
        and artifact["digest"] == "sha256:" + hashlib.sha256(raw).hexdigest(),
        "artifact digest",
    )
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        names = archive.namelist()
        require(
            len(names) <= 8
            and len(set(names)) == len(names)
            and "producer.json" in names,
            "artifact members",
        )
        member = archive.getinfo("producer.json")
        require(not member.is_dir() and member.file_size <= 64 * 1024, "receipt size")
        require(
            member.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)
            and not member.flag_bits & 1,
            "unsupported receipt encoding",
        )
        return decode(archive.read(member))


def eligible(current, receipt, run, job, artifact, commit, classify):
    require(
        isinstance(receipt, dict)
        and set(receipt) == FIELDS | {"schema", "producer"}
        and type(receipt["schema"]) is int
        and receipt["schema"] == 1
        and receipt["producer"] == "actual-soak",
        "receipt schema or reuse chain",
    )
    require(
        all(
            type(receipt[key]) is int and receipt[key] > 0
            for key in ("repository_id", "pr", "run", "attempt", "workflow_id")
        ),
        "receipt ID types",
    )
    require(
        all(
            isinstance(receipt[key], str)
            and re.fullmatch(r"[0-9a-f]{40}", receipt[key])
            for key in ("base", "head", "checkout", "tree")
        ),
        "receipt object IDs",
    )
    for key in (
        "repository",
        "repository_id",
        "pr",
        "branch",
        "base",
        "kind",
        "policy",
        "environment",
        "workflow_id",
    ):
        require(receipt[key] == current[key], f"changed {key}")
    require(
        receipt["head"] != current["head"]
        and re.fullmatch(r"[0-9a-f]{40}", receipt["head"]),
        "prior head",
    )
    git("merge-base", "--is-ancestor", receipt["head"], current["head"])
    require(
        run["status"] == "completed"
        and run["conclusion"] == "success"
        and run["event"] == "pull_request"
        and run["path"] == WORKFLOW
        and run["workflow_id"] == current["workflow_id"]
        and run["id"] == receipt["run"]
        and run["run_attempt"] == receipt["attempt"]
        and run["head_sha"] == receipt["head"]
        and run["head_branch"] == current["branch"]
        and run["repository"]["id"]
        == run["head_repository"]["id"]
        == current["repository_id"],
        "run provenance",
    )
    prs = run["pull_requests"]
    require(
        len(prs) == 1
        and prs[0]["number"] == current["pr"]
        and prs[0]["base"]["sha"] == current["base"]
        and prs[0]["head"]["sha"] == receipt["head"],
        "run PR/base",
    )
    require(
        job["name"] == "local-relay"
        and job["status"] == "completed"
        and job["conclusion"] == "success"
        and job["run_id"] == receipt["run"]
        and job["run_attempt"] == receipt["attempt"],
        "producer job",
    )
    for name in (SHORT, SOAK):
        steps = [step for step in job["steps"] if step["name"] == name]
        require(
            len(steps) == 1
            and steps[0]["status"] == "completed"
            and steps[0]["conclusion"] == "success",
            "producer did not execute actual controls and soak",
        )
    require(
        artifact["expired"] is False
        and artifact["name"] == f"relay-r7-local-{receipt['run']}-{receipt['attempt']}"
        and artifact["workflow_run"]["id"] == receipt["run"]
        and artifact["workflow_run"]["head_sha"] == receipt["head"]
        and artifact["workflow_run"]["repository_id"] == current["repository_id"]
        and artifact["workflow_run"]["head_repository_id"] == current["repository_id"],
        "artifact binding",
    )
    require(
        commit["sha"] == receipt["checkout"]
        and commit["tree"]["sha"] == receipt["tree"]
        and [parent["sha"] for parent in commit["parents"]] == receipt["parents"],
        "tested checkout",
    )
    require(
        (receipt["kind"] == "head" and receipt["checkout"] == receipt["head"])
        or receipt["parents"] == [current["base"], receipt["head"]],
        "producer merge parents",
    )
    require(run["id"] != current["run"], "current run cannot be a producer")
    policy = runpy.run_path(str(Path(__file__).with_name("ci-scope.py")))
    require(
        digest(policy["validation_inventory"](receipt["head"])) == current["policy"],
        "producer policy drift",
    )
    delta = classify(receipt["head"], current["head"])
    expected = set(policy["GATES"]) | {"typecheck", "relay_soak"}
    require(
        all(type(delta.get(key)) is bool for key in expected)
        and delta["relay_soak"] is False,
        "delta requires soak",
    )
    return {
        "verified": True,
        "run": receipt["run"],
        "artifact": artifact["id"],
        "digest": artifact["digest"],
    }


class API:
    def __init__(self, repository):
        self.prefix = f"repos/{repository}/"
        self.deadline = time.monotonic() + 30

    def read(self, path, binary=False):
        remaining = self.deadline - time.monotonic()
        require(remaining > 0, "lookup time budget exhausted")
        proc = subprocess.run(
            [
                "gh",
                "api",
                "--hostname",
                "github.com",
                "--allow-escape-sequences",
                self.prefix + path,
            ],
            capture_output=True,
            check=False,
            timeout=min(10, remaining),
        )
        require(proc.returncode == 0, "evidence API unavailable")
        require(
            len(proc.stdout) <= (MAX_ARCHIVE if binary else 2 * 1024 * 1024),
            "oversized API response",
        )
        return proc.stdout if binary else decode(proc.stdout)


def candidates(runs, current):
    require(isinstance(runs, list) and len(runs) <= 20, "run limit")
    result = []
    for candidate in runs:
        require(isinstance(candidate, dict), "invalid run metadata")
        prs = candidate.get("pull_requests", [])
        require(
            isinstance(prs, list)
            and all(
                isinstance(pr, dict) and isinstance(pr.get("base"), dict) for pr in prs
            ),
            "invalid run PR metadata",
        )
        if (
            candidate.get("conclusion") == "success"
            and candidate.get("head_sha") != current["head"]
            and len(prs) == 1
            and prs[0].get("number") == current["pr"]
            and prs[0].get("base", {}).get("sha") == current["base"]
        ):
            result.append(candidate)
    return result[:3]


def lookup(current):
    api = API(current["repository"])
    workflow = urllib.parse.quote(WORKFLOW.rsplit("/", 1)[-1], safe="")
    identity = api.read(f"actions/workflows/{workflow}")
    require(
        identity["path"] == WORKFLOW
        and type(identity["id"]) is int
        and identity["id"] > 0,
        "workflow identity",
    )
    current = {**current, "workflow_id": identity["id"]}
    branch = urllib.parse.quote(current["branch"], safe="")
    runs = api.read(
        f"actions/workflows/{workflow}/runs?event=pull_request&status=completed&per_page=20&branch={branch}"
    )
    policy = runpy.run_path(str(Path(__file__).with_name("ci-scope.py")))
    for candidate in candidates(runs["workflow_runs"], current):
        try:
            run_id, attempt = candidate["id"], candidate["run_attempt"]
            require(
                type(run_id) is int
                and run_id > 0
                and type(attempt) is int
                and attempt > 0,
                "API run IDs",
            )
            artifacts = api.read(f"actions/runs/{run_id}/artifacts?per_page=100")[
                "artifacts"
            ]
            require(len(artifacts) <= 100, "artifact limit")
            matching = [
                item
                for item in artifacts
                if item["name"] == f"relay-r7-local-{run_id}-{attempt}"
            ]
            require(len(matching) == 1, "producer artifact unavailable")
            artifact = matching[0]
            require(
                type(artifact["id"]) is int
                and artifact["id"] > 0
                and 0 < artifact["size_in_bytes"] <= MAX_ARCHIVE
                and artifact["expired"] is False,
                "artifact size/expiry",
            )
            receipt = archive_receipt(
                api.read(f"actions/artifacts/{artifact['id']}/zip", binary=True),
                artifact,
            )
            require(re.fullmatch(r"[0-9a-f]{40}", receipt["checkout"]), "checkout ID")
            commit = api.read(f"git/commits/{receipt['checkout']}")
            jobs = api.read(
                f"actions/runs/{run_id}/attempts/{attempt}/jobs?per_page=100"
            )["jobs"]
            require(len(jobs) <= 100, "job limit")
            matching = [job for job in jobs if job["name"] == "local-relay"]
            require(len(matching) == 1, "producer job unavailable")
            run = api.read(f"actions/runs/{run_id}")
            return eligible(
                current,
                receipt,
                run,
                matching[0],
                artifact,
                commit,
                policy["classify"],
            )
        except (
            Ineligible,
            KeyError,
            TypeError,
            ValueError,
            OSError,
            subprocess.SubprocessError,
            zipfile.BadZipFile,
        ):
            continue  # No evidence is a miss, not a replacement result or a new runtime claim.
    raise Ineligible("no qualified completed producer")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write-receipt", action="store_true")
    args = parser.parse_args()
    try:
        current = context(protected=not args.write_receipt)
        if args.write_receipt:
            require(
                os.environ.get("SHORT_CONCLUSION")
                == os.environ.get("SOAK_CONCLUSION")
                == "success",
                "actual producer steps did not succeed",
            )
            identity = API(current["repository"]).read("actions/workflows/relay-r7.yml")
            require(
                identity["path"] == WORKFLOW
                and type(identity["id"]) is int
                and identity["id"] > 0,
                "workflow identity",
            )
            current["workflow_id"] = identity["id"]
            Path("r7-receipts/producer.json").write_text(
                json.dumps(
                    {**current, "schema": 1, "producer": "actual-soak"}, sort_keys=True
                )
                + "\n"
            )
            print(
                json.dumps({"producer_receipt": "written", "live_reuse": "unverified"})
            )
            return
        result = lookup(current)
    except Ineligible as error:
        result = {
            "verified": False,
            "reason": f"{error}; original soak remains selected",
        }
    except (
        KeyError,
        TypeError,
        ValueError,
        OSError,
        subprocess.SubprocessError,
        zipfile.BadZipFile,
    ):
        result = {
            "verified": False,
            "reason": "Evidence/context unavailable or ineligible; original soak remains selected",
        }
    print(json.dumps(result, sort_keys=True))
    if not args.write_receipt:
        with open(os.environ["GITHUB_OUTPUT"], "a") as stream:
            stream.write(f"verified={str(result['verified']).lower()}\n")
        if result["verified"]:
            with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as stream:
                stream.write(
                    f"61-minute soak evidence reused from [run {result['run']}]"
                    f"(https://github.com/{current['repository']}/actions/runs/{result['run']}), "
                    f"artifact {result['artifact']}, "
                    f"{result['digest']}. This head ran short controls, not a new hour measurement.\n"
                )


if __name__ == "__main__":
    main()
