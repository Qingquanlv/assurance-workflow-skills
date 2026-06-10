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

REVIEW_PROMPT = """You are a senior QA documentation reviewer for the Assurance Workflow Skills (AWS) system.

Review the following changes to AWS skill files and identify **concrete problems only** — not style suggestions or minor wording preferences.

Flag issues only if they are:
1. **Broken contract**: a skill output/input no longer matches what another skill expects
2. **Rule violation**: the change contradicts a hard rule defined in aws-workflow (e.g. inline execution, forbidden subagent patterns, codegen hard gates)
3. **Schema mismatch**: workflow-state.yaml schema fields are inconsistent across skills
4. **Missing required section**: a skill is missing a required gate, phase contract, or status machine element
5. **Factual error**: wrong file path, wrong status value, wrong phase number, or self-contradiction within the file
6. **Naming inconsistency**: skill name in frontmatter doesn't match directory name, or file naming conventions violated

Do NOT flag:
- Minor wording differences
- Style preferences
- Suggestions for additional content
- Philosophical disagreements with design decisions

For each issue found, output exactly this JSON structure (no markdown, raw JSON only):
{
  "has_issues": true,
  "summary": "one-line summary of overall finding",
  "issues": [
    {
      "file": "path/to/SKILL.md",
      "severity": "high|medium|low",
      "rule": "which rule or contract is violated",
      "finding": "concrete description of the problem",
      "line_hint": "optional: approximate section or heading where the problem is"
    }
  ]
}

If no concrete issues found, output:
{
  "has_issues": false,
  "summary": "No concrete issues found",
  "issues": []
}

Here are the changed files with their git diff:

{diffs}
"""


def get_file_diff(filepath: str) -> str:
    try:
        result = subprocess.run(
            ["git", "diff", "HEAD~1", "HEAD", "--", filepath],
            capture_output=True, text=True, check=True
        )
        diff = result.stdout.strip()
        if not diff:
            # File might be new
            result = subprocess.run(
                ["git", "show", f"HEAD:{filepath}"],
                capture_output=True, text=True
            )
            if result.returncode == 0:
                return f"[NEW FILE] {filepath}\n\n{result.stdout[:3000]}"
        return diff[:4000]  # Limit diff size per file
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
    model = os.environ.get("AI_MODEL", "claude-sonnet-4-5")
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

    # Call AI API
    try:
        from openai import OpenAI
        client = OpenAI(api_key=api_key, base_url=base_url)
        response = client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.1,
            max_tokens=2000,
        )
        content = response.choices[0].message.content.strip()
    except Exception as e:
        print(f"ERROR calling AI API: {e}")
        set_output("has_issues", "false")
        return

    print(f"AI response:\n{content}")

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
