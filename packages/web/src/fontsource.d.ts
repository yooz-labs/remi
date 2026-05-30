// Fontsource packages ship CSS that is imported for side effects only
// (they register @font-face rules). They have no TS types, so declare the
// bare specifiers as side-effect modules.
declare module '@fontsource-variable/*';
