/** CSS Modules ambient declaration for the client build (tsdown inlines CSS). */
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}

declare module '*.module.css?inline' {
  const classes: Record<string, string>
  export default classes
}