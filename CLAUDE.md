# Project Instructions

## Development Workflow

- Add all significant prompts (user messages) to prompts.md, organized by date
- Include prompts.md changes in git commits
- Significant prompts are those that request features, bug fixes, or architectural changes
- Exclude trivial prompts like "commit and push" or "fix typo"
- Reload VS Code window after each significant code change

## Architecture Notes

### Method Discovery for Structs

The extension displays methods for Rust structs using the following approach:
1. Use VS Code's definition provider to find the struct definition location
2. Extract the actual struct name from the definition (handle type aliases by scanning forward)
3. Use grep to search for `impl` blocks for that struct
4. Parse function declarations from impl blocks to extract full method signatures
5. Extract documentation from `///` comments (first paragraph, up to 3 lines)
6. Display methods with signatures as clickable links and docs below

Grep output format: `filename.rs:` or `filename.rs-` prefix must be stripped before parsing.

This approach works for both local structs and external crate types (e.g., `DateTime` from the `time` crate).

Note: Earlier approaches that modified the editor (inserting temporary `.` characters) caused glitches and should be avoided.

### Known Issues

- Method links currently show a notification placeholder; full method documentation navigation not yet implemented
- reload vscode window after each signficant code change