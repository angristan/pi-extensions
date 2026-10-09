# image-paste

Turns a pasted screenshot or image file into an `[Image N]` token in the
editor, shows its thumbnail above the editor, attaches the image when the
prompt is sent, and keeps a thumbnail row in the transcript. Click a thumbnail
or press `Alt+I` for a full-screen viewer. The design follows OpenCode's prompt
image attachments.

## Usage

```text
Paste an image or image path   Insert [Image N] and show its thumbnail
Backspace / Delete on a token  Remove the whole [Image N] and its image
Alt+I or /images               Open the viewer at the latest pasted image
Click a thumbnail              Open the viewer at that image (fullscreen mode)
←/→ (h/l)                      Previous / next image in the viewer
Esc, q or Enter                Close the viewer
```

A paste is converted only when it consists entirely of existing image file
paths (PNG, JPEG, GIF or WebP, up to 32 MiB): Herdr's clipboard images, files
dropped onto the terminal (quoted, backslash-escaped or `file://`), and the
temporary file Pi's own `Ctrl+V` writes. Other pastes, and pastes in bash mode
(`!`), are untouched.

Each token is one highlighted block (bold, on the theme's warning color) and
one unit in the editor: one `Backspace`, `Delete` or word deletion removes all
of it, the arrow keys step over it, and one undo restores it with its image.
Thumbnails have no captions; they follow token order. On submit, each
referenced image is attached in label order and the tokens stay in the text,
so the model can tell `[Image 1]` from `[Image 2]`. Pi then applies its usual
image resizing. Tokens recalled from prompt history are plain text; paste the
image again.

Originals are copied to `$PI_CODING_AGENT_DIR/image-paste/` (owner-only,
named by SHA-256) so transcript thumbnails and the viewer keep working after
temporary clipboard files disappear. Nothing removes them automatically.

## Configuration

Changes apply immediately and are saved to
`$PI_CODING_AGENT_DIR/image-paste.json`:

```text
/images prompt on|off          Thumbnails above the editor (default on)
/images transcript on|off      Thumbnails under sent prompts (default on)
/images rows auto|2-16         Thumbnail height in rows (default auto)
/images color <name|#rrggbb>   Token block color (default warning)
/images settings               Show the current settings
```

```json
{ "promptPreview": true, "transcriptPreview": true, "previewRows": "auto", "tokenColor": "warning" }
```

`auto` sizes thumbnails to a quarter of the terminal height, 4 to 8 rows. With
a preview off, tokens, attachments and the viewer still work. `tokenColor`
takes a Pi theme color name or a hex value. Commands keep unrelated keys and
refuse to overwrite malformed JSON; invalid values fall back to the defaults.

## Dependencies

- **Runtime:** Pi terminal-input, widget, input, entry-renderer, Markdown and
  image APIs, with Pi's image resizer.
- **npm packages:** None.
- **Depends on extensions:** None.
- **Used by extensions:** None.

## Limitations

- Token blocks extend the editor's internal segmentation, the mechanism Pi
  uses for its own `[paste #N]` markers, and its rendered lines, on whichever
  editor has focus, including replacements from other extensions. If a Pi
  release removes it, tokens become plain text and still attach their images.
  Word wrap may break a line just before a token rather than at the space.
- Thumbnails and the viewer need terminal image support. Herdr renders Kitty
  graphics but Pi does not detect it: set `PI_IMAGE_PROTOCOL=kitty` or
  `terminal.images: "kitty"`. Without image support, tokens still work and
  thumbnails show as labels.
- Each thumbnail row is composited into one PNG so Pi's Kitty image caching,
  cropping and scrolling apply unchanged. A row that does not fit the terminal
  width is followed by a `+N more` line; the viewer shows every image.
- Clicking needs fullscreen mode, the default. The viewer fits images to the
  terminal, enlarging small ones; it does not zoom past the screen.
- When Pi's own `Ctrl+V` path is converted, the editor cursor moves to the end.
- Extensions load in directory order, so this one attaches images before
  [`image-store`](../image-store/) handles input: sent images are still stored
  as sidecars. `image-store` also shows its own preview of each sent image;
  use `/images transcript off` to keep only that one.
