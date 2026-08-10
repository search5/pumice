# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Fixed

- Pressing Tab inside this plugin's Settings tab now moves focus to the next
  field, as expected. (Obsidian's own Settings modal otherwise intercepts Tab
  and repurposes it as row-jump navigation; this plugin now stops that
  interception from reaching it.)
- "Publish current file" (the file context-menu action) now correctly cancels
  (unpublishes) a file whose frontmatter is `publish: false`, instead of only
  ever offering to publish. A file with no `publish` field at all is still
  blocked with an error, since there's no way to tell what was intended.

### Changed

- The general "Publish changes" scan no longer treats a file as eligible just
  because it sits under a configured "included folder" — only an explicit
  `publish: true` (to publish) or `publish: false` (to cancel) in a file's own
  frontmatter decides what shows up in the list now. Folders can still be
  marked "included" from the file/folder context menu, but that setting no
  longer changes which files appear.
