declare module 'qrcode' {
  function renderTerminal(
    text: string,
    options: { type: 'terminal'; small?: boolean; errorCorrectionLevel?: 'M'; margin?: number },
  ): Promise<string>;
  export { renderTerminal as toString };
}
