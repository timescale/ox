const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>I can haz routez?</title>
  <style>
    body {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      background: #1a1a2e;
      font-family: 'Comic Sans MS', 'Chalkboard SE', cursive, sans-serif;
      color: #e0e0e0;
    }
    h1 {
      font-size: 3rem;
      margin-bottom: 2rem;
      color: #f5c542;
      text-shadow: 2px 2px 4px rgba(0,0,0,0.5);
    }
    svg {
      filter: drop-shadow(4px 4px 8px rgba(0,0,0,0.4));
    }
  </style>
</head>
<body>
  <h1>I can haz routez?</h1>
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 320" width="300" height="320">
    <!-- Body -->
    <ellipse cx="150" cy="230" rx="90" ry="80" fill="#666" />
    <!-- Tail -->
    <path d="M60 240 Q10 200 30 160 Q35 150 45 155 Q55 160 50 170 Q40 200 75 230" fill="#555" stroke="#444" stroke-width="1"/>
    <!-- Head -->
    <circle cx="150" cy="130" r="60" fill="#777" />
    <!-- Left ear -->
    <polygon points="105,85 90,30 130,70" fill="#777" stroke="#666" stroke-width="1"/>
    <polygon points="108,82 97,42 127,72" fill="#ffb6c1"/>
    <!-- Right ear -->
    <polygon points="195,85 210,30 170,70" fill="#777" stroke="#666" stroke-width="1"/>
    <polygon points="192,82 203,42 173,72" fill="#ffb6c1"/>
    <!-- Left eye - half-lidded snarky look -->
    <ellipse cx="125" cy="125" rx="16" ry="14" fill="white"/>
    <ellipse cx="128" cy="127" rx="8" ry="10" fill="#2d5016"/>
    <ellipse cx="129" cy="128" rx="4" ry="5" fill="black"/>
    <ellipse cx="131" cy="125" rx="2" ry="2" fill="white"/>
    <!-- Left eyelid (half-closed for snark) -->
    <path d="M109 118 Q125 128 141 118 Q125 112 109 118Z" fill="#777"/>
    <!-- Right eye - half-lidded snarky look -->
    <ellipse cx="175" cy="125" rx="16" ry="14" fill="white"/>
    <ellipse cx="172" cy="127" rx="8" ry="10" fill="#2d5016"/>
    <ellipse cx="171" cy="128" rx="4" ry="5" fill="black"/>
    <ellipse cx="169" cy="125" rx="2" ry="2" fill="white"/>
    <!-- Right eyelid (half-closed for snark) -->
    <path d="M159 118 Q175 128 191 118 Q175 112 159 118Z" fill="#777"/>
    <!-- Nose -->
    <polygon points="150,142 145,148 155,148" fill="#ffb6c1"/>
    <!-- Smirk mouth -->
    <path d="M135 155 Q145 160 150 158 Q160 162 170 152" fill="none" stroke="#444" stroke-width="2.5" stroke-linecap="round"/>
    <!-- Whiskers left -->
    <line x1="90" y1="138" x2="130" y2="145" stroke="#aaa" stroke-width="1.5"/>
    <line x1="88" y1="148" x2="128" y2="150" stroke="#aaa" stroke-width="1.5"/>
    <line x1="90" y1="158" x2="130" y2="155" stroke="#aaa" stroke-width="1.5"/>
    <!-- Whiskers right -->
    <line x1="210" y1="138" x2="170" y2="145" stroke="#aaa" stroke-width="1.5"/>
    <line x1="212" y1="148" x2="172" y2="150" stroke="#aaa" stroke-width="1.5"/>
    <line x1="210" y1="158" x2="170" y2="155" stroke="#aaa" stroke-width="1.5"/>
    <!-- Front paws -->
    <ellipse cx="115" cy="295" rx="22" ry="12" fill="#888"/>
    <ellipse cx="185" cy="295" rx="22" ry="12" fill="#888"/>
    <!-- Paw lines -->
    <path d="M106 295 Q108 289 110 295" fill="none" stroke="#666" stroke-width="1.2"/>
    <path d="M114 295 Q116 289 118 295" fill="none" stroke="#666" stroke-width="1.2"/>
    <path d="M176 295 Q178 289 180 295" fill="none" stroke="#666" stroke-width="1.2"/>
    <path d="M184 295 Q186 289 188 295" fill="none" stroke="#666" stroke-width="1.2"/>
    <!-- Speech bubble -->
    <rect x="185" y="30" rx="10" ry="10" width="110" height="50" fill="white" stroke="#ccc" stroke-width="1.5"/>
    <polygon points="195,80 185,70 205,75" fill="white" stroke="#ccc" stroke-width="1.5"/>
    <rect x="186" y="31" rx="9" ry="9" width="108" height="48" fill="white"/>
    <text x="240" y="55" text-anchor="middle" font-family="Comic Sans MS, cursive" font-size="11" fill="#333">404 purrs</text>
    <text x="240" y="70" text-anchor="middle" font-family="Comic Sans MS, cursive" font-size="11" fill="#333">not found</text>
  </svg>
</body>
</html>`;

Bun.serve({
  port: 3123,
  fetch() {
    return new Response(html, {
      headers: { 'Content-Type': 'text/html' },
    });
  },
});

console.log('Snarky cat server running at http://localhost:3123');
