/**
 * Raw PTY bytes of Claude Code permission dialogs, captured live (no mocks).
 *
 * `WRAPPED_DIRECTORY_DIALOG` is the dialog from the #1134 reproduction
 * (Claude Code 2.1.287, 120 columns, auto-approve off): a `Bash` permission
 * whose `permission_suggestions` were `addDirectories` + `setMode`, rendered
 * as THREE options. Option 2's label is longer than the terminal, so Claude
 * wraps it onto a second row, and every word is placed by cursor-column
 * jumps (`ESC[nG`) instead of spaces. Only the directory path is changed from
 * the capture (it named a local scratch directory); the escape sequences,
 * wrap point and layout are as recorded.
 *
 * The hook built FOUR options for this dialog; a phone "No" typed `4`,
 * Claude ignored it, and the Enter after it confirmed "1. Yes".
 */
export const WRAPPED_DIRECTORY_DIALOG = [
  '\r\u001b[1C\u001b[1B\u001b[39mDo you want to proceed?\u001b[K\r\r\n',
  '\u001b[2G\u001b[38;2;177;185;249m❯\u001b[4G\u001b[38;2;153;153;153m1.\u001b[7G\u001b[38;2;177;185;249mYes\u001b[39m\r\r\n',
  '\u001b[4G\u001b[38;2;153;153;153m2.\u001b[7G\u001b[39mYes,\u001b[12Gand\u001b[16Galways\u001b[23Gallow\u001b[29Gaccess\u001b[36Gto\u001b[39G',
  '\u001b[1m/private/tmp/remi-e5/-Users-dev-Documents-git-example-workspace/0f1e2d3c-4b5a-6978-86\u001b[22m\r\r\n',
  '\u001b[7G\u001b[1m66-00a1b2c3d4e5/scratchpad/spike/work/e5-classic-detached-no\u001b[68G\u001b[22mfrom\u001b[73Gthis\u001b[78Gproject\r\r\n',
  '\u001b[4G\u001b[38;2;153;153;153m3.\u001b[7G\u001b[39mNo\r\r\n',
  '\r\r\n',
  '\u001b[2G\u001b[38;2;153;153;153mEsc\u001b[6Gto\u001b[9Gcancel\u001b[16G·\u001b[18GTab\u001b[22Gto\u001b[25Gamend\u001b[39m\r\r\n',
  '\u001b[1C\u001b[6A',
].join('');

/** The directory `WRAPPED_DIRECTORY_DIALOG`'s option 2 grants, as the
 *  `addDirectories` suggestion names it. */
export const WRAPPED_DIRECTORY =
  '/private/tmp/remi-e5/-Users-dev-Documents-git-example-workspace/0f1e2d3c-4b5a-6978-8666-00a1b2c3d4e5/scratchpad/spike/work/e5-classic-detached-no';
