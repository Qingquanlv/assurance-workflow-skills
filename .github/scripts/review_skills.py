"""
Skill Review Script for GitHub Actions.

Reads changed SKILL.md / agent .md files, calls an OpenAI-compatible AI API
to review them, and outputs GitHub Actions step outputs indicating whether
issues were found and the issue title/body to create.

Required env vars:
  AI_API_KEY     - API key (required)
  AI_BASE_URL    - API base URL (default: https://api.anthropic.com/v1)
  AI_MODEL       - Model name (default: claude-sonnet-4-5)
  CHANGED_FILES  - Newline-separated list of changed file paths
  COMMIT_SHA     - Current commit SHA
  COMMIT_MESSAGE - Commit message
"""

import os
import subprocess
import sys
import json

REVIEW_PROMPT = """You are a QA doc reviewer for AWS (Assurance Workflow Skills).

Review these git diff additions. Flag ONLY concrete problems:
- Rule violation: contradicts aws-workflow hard rules (inline execution, no subagent codegen, etc.)
- Self-contradiction within the file
- Wrong phase number, wrong status value, wrong file path
- Broken contract between skills

Output raw JSON only, no markdown:
{"has_issues":true,"summary":"...","issues":[{"file":"...","severity":"high|medium|low","rule":"...","finding":"..."}]}

Or if no issues:
{"has_issues":false,"summary":"No concrete issues found","issues":[]}

Changed files diff:
{diffs}"""


def get_file_diff(filepath: str) -> str:
    """Return only added/removed lines from the diff (no context), capped at 1500 chars."""
    try:
        result = subprocess.run(
            ["git", "diff", "HEAD~1", "HEAD", "--unified=0", "--", filepath],
            capture_output=True, text=True, check=True
        )
        diff = result.stdout.strip()
        if not diff:
            # File might be new — show a small excerpt of the content
            result = subprocess.run(
                ["git", "show", f"HEAD:{filepath}"],
                capture_output=True, text=True
            )
            if result.returncode == 0:
                return f"[NEW FILE] {filepath}\n\n{result.stdout[:800]}"
            return "[No diff and file not found]"
        # Keep only hunk headers and +/- lines, skip context lines
        lines = []
        for line in diff.splitlines():
            if line.startswith("@@") or line.startswith("+") or line.startswith("-"):
                lines.append(line)
        compact = "\n".join(lines)
        return compact[:1500]  # Hard cap
    except Exception as e:
        return f"[Error reading diff for {filepath}: {e}]"


def set_output(name: str, value: str):
    """Write GitHub Actions step output."""
    github_output = os.environ.get("GITHUB_OUTPUT", "")
    if github_output:
        # Multiline values need special handling
        delimiter = "EOF_DELIM"
        with open(github_output, "a") as f:
            f.write(f"{name}<<{delimiter}\n{value}\n{delimiter}\n")
    else:
        print(f"::set-output name={name}::{value}")


def main():
    api_key = os.environ.get("AI_API_KEY", "")
    if not api_key:
        print("ERROR: AI_API_KEY not set. Skipping review.")
        set_output("has_issues", "false")
        return

    base_url = os.environ.get("AI_BASE_URL", "https://api.anthropic.com/v1")
    model = os.environ.get("AI_MODEL", "kimi-k2.7-code")
    changed_files_raw = os.environ.get("CHANGED_FILES", "").strip()
    commit_sha = os.environ.get("COMMIT_SHA", "unknown")[:7]
    commit_message = os.environ.get("COMMIT_MESSAGE", "").split("\n")[0][:100]

    if not changed_files_raw:
        print("No changed files provided. Skipping review.")
        set_output("has_issues", "false")
        return

    changed_files = [f.strip() for f in changed_files_raw.splitlines() if f.strip()]
    print(f"Reviewing {len(changed_files)} file(s): {changed_files}")

    # Build diffs section
    diffs_section = ""
    for filepath in changed_files:
        diff = get_file_diff(filepath)
        diffs_section += f"\n\n### {filepath}\n```diff\n{diff}\n```"

    if not diffs_section.strip():
        print("No diff content found. Skipping review.")
        set_output("has_issues", "false")
        return

    prompt = REVIEW_PROMPT.replace("{diffs}", diffs_section)
    print(f"DEBUG prompt length: {len(prompt)} chars")

    # Call AI API
    try:
        from openai import OpenAI
        client = OpenAI(api_key=api_key, base_url=base_url)
        response = client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            temperature=1,
        )
        raw_content = response.choices[0].message.content
        print(f"DEBUG finish_reason: {response.choices[0].finish_reason}")
        print(f"DEBUG raw content type: {type(raw_content)}, len: {len(raw_content) if raw_content else 0}")
        content = (raw_content or "").strip()
    except Exception as e:
        print(f"ERROR calling AI API: {e}")
        set_output("has_issues", "false")
        return

    print(f"AI response:\n{content}")

    if not content:
        print("WARNING: AI returned empty response. Treating as no issues.")
        set_output("has_issues", "false")
        return

    # Parse JSON response
    try:
        # Strip markdown code fences if present
        if content.startswith("```"):
            content = "\n".join(content.split("\n")[1:])
            if content.endswith("```"):
                content = content[:-3]
        result = json.loads(content.strip())
    except json.JSONDecodeError as e:
        print(f"WARNING: Could not parse AI response as JSON: {e}")
        set_output("has_issues", "false")
        return

    has_issues = result.get("has_issues", False)
    issues = result.get("issues", [])
    summary = result.get("summary", "")

    set_output("has_issues", "true" if has_issues else "false")

    if not has_issues or not issues:
        print(f"No issues found: {summary}")
        return

    # Build issue title and body
    high = [i for i in issues if i.get("severity") == "high"]
    severity_label = "🔴 High" if high else "🟡 Medium/Low"

    issue_title = f"[Skill Review] {severity_label} — {commit_sha}: {commit_message}"

    body_lines = [
        f"## Skill Review — `{commit_sha}`",
        f"",
        f"**Commit**: `{commit_sha}` — {commit_message}",
        f"**Files reviewed**: {', '.join(f'`{f}`' for f in changed_files)}",
        f"**Summary**: {summary}",
        f"",
        f"---",
        f"",
        f"## Issues Found",
        f"",
    ]

    for i, issue in enumerate(issues, 1):
        sev = issue.get("severity", "?").upper()
        emoji = {"HIGH": "🔴", "MEDIUM": "🟡", "LOW": "🔵"}.get(sev, "⚪")
        body_lines += [
            f"### {emoji} Issue {i} — {sev}",
            f"",
            f"**File**: `{issue.get('file', '?')}`",
            f"**Rule violated**: {issue.get('rule', '?')}",
            f"**Finding**: {issue.get('finding', '?')}",
        ]
        if issue.get("line_hint"):
            body_lines.append(f"**Location**: {issue['line_hint']}")
        body_lines.append("")

    body_lines += [
        "---",
        "",
        f"*Auto-generated by [skill-review workflow](../../actions/workflows/skill-review.yml)*",
    ]

    issue_body = "\n".join(body_lines)

    set_output("issue_title", issue_title)
    set_output("issue_body", issue_body)
    print(f"Issues found: {len(issues)}. Issue will be created.")


if __name__ == "__main__":
    main()
