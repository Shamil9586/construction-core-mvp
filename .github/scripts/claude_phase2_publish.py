#!/usr/bin/env python3
"""Validate a data-only AI report and post one PR comment in a separate job."""
import json
import os
import re
import sys
from urllib.request import Request, urlopen

from claude_phase2_context import OWNER_ID, OWNER_LOGIN, event_pr_number

MAX_REPORT_BYTES = 12000
MAX_SUMMARY_CHARS = 3000
MAX_FINDINGS = 8
MAX_FINDING_CHARS = 900
ALLOWED_SEVERITIES = {"high", "medium", "low", "info"}
# Defense in depth: reject obvious credential, outbound-link and mention payloads.
UNSAFE = re.compile(r"https?://|!\[|@|github_pat_|gh[psuro]_|sk-ant-", re.I)


def safe_text(value, maximum):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ValueError("invalid or oversized report text")
    if any(ord(char) < 32 and char not in "\n\t" for char in value):
        raise ValueError("control characters in report")
    if UNSAFE.search(value):
        raise ValueError("disallowed link, mention or token-shaped text")
    return value.strip()


def render_report(raw):
    if not isinstance(raw, str) or len(raw.encode("utf-8")) > MAX_REPORT_BYTES:
        raise ValueError("missing or oversized structured output")
    result = json.loads(raw)
    if not isinstance(result, dict) or set(result) != {"summary", "findings"}:
        raise ValueError("unexpected structured report properties")
    summary = safe_text(result["summary"], MAX_SUMMARY_CHARS)
    findings = result["findings"]
    if not isinstance(findings, list) or len(findings) > MAX_FINDINGS:
        raise ValueError("invalid findings list")
    lines = [
        "### Claude PR analysis — restricted read-only mode",
        "",
        "**AI-generated assessment. PR text and patches were treated as untrusted data.**",
        "",
        "**Summary**",
        summary,
        "",
        "**Findings**",
    ]
    for item in findings:
        if not isinstance(item, dict) or set(item) != {"severity", "description"}:
            raise ValueError("unexpected finding properties")
        severity = item["severity"]
        if severity not in ALLOWED_SEVERITIES:
            raise ValueError("invalid finding severity")
        description = safe_text(item["description"], MAX_FINDING_CHARS)
        lines.append(f"- **{severity.upper()}**: {description}")
    if not findings:
        lines.append("- No findings stated; this does not imply security acceptance.")
    lines.extend(["", "_No code or PR configuration was modified by the analysis job._"])
    comment = "\n".join(lines)
    if len(comment) > 11000:
        raise ValueError("comment too long")
    return comment


def request_json(path, token, method="GET", payload=None):
    data = None
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = Request(
        "https://api.github.com" + path,
        data=data,
        method=method,
        headers={
            "Authorization": "Bearer " + token,
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    with urlopen(req, timeout=20) as response:
        return json.load(response)


def publish(event, event_name, repository, report, fetch, post):
    # Recheck authorization and live PR state in the writer job, independently
    # of its upstream GitHub Actions 'if' and the analysis job.
    number = event_pr_number(event, event_name)
    pr = fetch(f"/repos/{repository}/pulls/{number}")
    if pr.get("state") != "open":
        raise ValueError("PR was closed before publishing")
    if (pr.get("base") or {}).get("repo", {}).get("full_name") != repository:
        raise ValueError("incorrect PR target")
    body = render_report(report)
    return post(f"/repos/{repository}/issues/{number}/comments", {"body": body})


def main():
    # Only this job receives GH_WRITE_TOKEN. It never executes Claude.
    token = os.environ["GH_WRITE_TOKEN"]
    repo = os.environ["GITHUB_REPOSITORY"]
    event = json.loads(open(os.environ["GITHUB_EVENT_PATH"], encoding="utf-8").read())
    report = os.environ["CLAUDE_REVIEW_JSON"]
    result = publish(
        event,
        os.environ["GITHUB_EVENT_NAME"],
        repo,
        report,
        lambda p: request_json(p, token),
        lambda p, body: request_json(p, token, method="POST", payload=body),
    )
    if type(result.get("id")) is not int:
        raise ValueError("no published comment ID")
    print("Validated Claude PR comment posted successfully.")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"PR comment publication refused: {type(exc).__name__}", file=sys.stderr)
        sys.exit(1)
