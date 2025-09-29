# Project Instructions

## Development Workflow

- Add all significant prompts (user messages) to prompts.md, organized by date
- Include prompts.md changes in git commits
- Significant prompts are those that request features, bug fixes, or architectural changes
- Exclude trivial prompts like "commit and push" or "fix typo"

## Architecture Notes

### Method Discovery for Structs

The extension displays methods for Rust structs using the following approach:
1. Use VS Code's definition provider to find the struct definition location
2. Extract the actual struct name from the definition
3. Use ripgrep to search for `impl` blocks for that struct
4. Parse function declarations from impl blocks to extract method names

This approach works for both local structs and external crate types (e.g., `DateTime` from the `time` crate).

Note: Earlier approaches that modified the editor (inserting temporary `.` characters) caused glitches and should be avoided.
- reload vscode window after each signficant code change