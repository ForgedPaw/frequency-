import { defineConfig, loadEnv } from 'vite';
import triviaHandler from './api/trivia.js';

// Dev-only: `vite dev` doesn't know about the api/ folder — that's a Vercel
// convention. This middleware runs the exact same handler locally so
// /api/trivia works without needing the Vercel CLI for local testing.
// It has no effect on `vite build` / the real Vercel deployment.
function triviaDevApiPlugin() {
  return {
    name: 'trivia-api-dev-middleware',
    configureServer(server) {
      server.middlewares.use('/api/trivia', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        let raw = '';
        for await (const chunk of req) raw += chunk;
        try {
          req.body = raw ? JSON.parse(raw) : {};
        } catch (e) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'Invalid JSON body' }));
          return;
        }
        res.status = (code) => { res.statusCode = code; return res; };
        res.json = (obj) => {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(obj));
        };
        await triviaHandler(req, res);
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // loadEnv only returns values; also mirror ANTHROPIC_API_KEY onto
  // process.env since api/trivia.js reads it from there (matching Vercel's
  // actual runtime, where env vars live on process.env).
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY;

  return {
    plugins: [triviaDevApiPlugin()],
  };
});
