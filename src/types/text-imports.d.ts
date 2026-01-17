// Type declarations for Bun's text imports
declare module '*.Dockerfile' {
  const content: string;
  export default content;
}

declare module '*/Dockerfile' {
  const content: string;
  export default content;
}
