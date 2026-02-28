/**
 * CRE Bridge Server
 * Tiny local HTTP server that bridges the Tauri dApp to CRE workflow simulations.
 * 
 * Usage:  bun run cre-bridge.ts
 * Runs on: http://localhost:3456
 * 
 * The dApp frontend calls fetch("http://localhost:3456/verify", { body: ... })
 * This server writes the payload and spawns `cre workflow simulate` with it.
 */

const CRE_PROJECT_DIR = `${Bun.env.USERPROFILE || Bun.env.HOME}/Pictures/CONVERGENCE/ColossusW/workflows/cre`.replace(/\\/g, "/");
const PORT = 3456;
const CHAIN_SELECTOR_MAP: Record<number, string> = {
  11155111: "ethereum-testnet-sepolia",
  84532:    "ethereum-testnet-sepolia-base-1",
};

const server = Bun.serve({
  port: PORT,

  async fetch(req: Request): Promise<Response> {
    // CORS headers for local Tauri/Vite dev server
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    // Handle preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(req.url);

    // Health check
    if (url.pathname === "/health") {
      return Response.json({ status: "ok", cwd: CRE_PROJECT_DIR }, { headers: corsHeaders });
    }

    // POST /verify — run colossus-verify workflow
    if (url.pathname === "/verify" && req.method === "POST") {
      try {
        const body = await req.json() as {
          userAddress: string;
          tokenAddresses: string[];
          amounts?: string[];
          units?: number;
          chainId?: number;
        };

        if (!body.userAddress || !body.tokenAddresses?.length) {
          return Response.json(
            { error: "Missing userAddress or tokenAddresses" },
            { status: 400, headers: corsHeaders }
          );
        }

        const chainSelectorName = body.chainId 
          ? CHAIN_SELECTOR_MAP[body.chainId] || "ethereum-testnet-sepolia"
          : "ethereum-testnet-sepolia";
          console.log(`[CRE Bridge] Chain: ${body.chainId} → ${chainSelectorName}`);

        const payload = JSON.stringify({
          userAddress: body.userAddress,
          tokenAddresses: body.tokenAddresses,
          amounts: body.amounts || [],
          units: body.units || 1,
          chainSelectorName,  // NEW — workflow reads this
        });

        console.log(`[CRE Bridge] Running colossus-verify for ${body.userAddress}`);
        console.log(`[CRE Bridge] Tokens: ${body.tokenAddresses.join(", ")}`);

        const proc = Bun.spawn(
          [
            "cre",
            "workflow",
            "simulate",
            "colossus-verify",
            "--non-interactive",
            "--trigger-index",
            "0",
            "--http-payload",
            payload,
            "--target",
            "staging-settings",
          ],
          {
            cwd: CRE_PROJECT_DIR,
            stdout: "pipe",
            stderr: "pipe",
          }
        );

        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        const exitCode = await proc.exited;

        // Stream full CRE simulation output to bridge console
        if (stderr) stderr.split("\n").forEach(line => line.trim() && console.log(`  ${line}`));
        if (stdout) stdout.split("\n").forEach(line => line.trim() && console.log(`  ${line}`));
        console.log(`[CRE Bridge] colossus-verify exit code: ${exitCode}`);

        if (exitCode !== 0) {
          return Response.json(
            { error: `CRE simulation failed (exit ${exitCode})`, stderr: stderr.slice(-500), stdout: stdout.slice(-500) },
            { status: 500, headers: corsHeaders }
          );
        }

        // Parse "Workflow Simulation Result:" from stdout
        const resultMatch = stdout.match(/Workflow Simulation Result:\s*([\s\S]*?)(?:\n\d{4}-|\n$|$)/);
        if (resultMatch) {
          let jsonStr = resultMatch[1].trim();
          try {
            let parsed = JSON.parse(jsonStr);
            // Unwrap { Result: "..." } if double-encoded
            if (parsed.Result && typeof parsed.Result === "string") {
              parsed = JSON.parse(parsed.Result);
            } else if (typeof parsed === "string") {
              parsed = JSON.parse(parsed);
            }
            console.log(`[CRE Bridge] Result: verified=${parsed.verified}`);
            return Response.json(parsed, { headers: corsHeaders });
          } catch {
            // Try to find any JSON object in the match
            const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              try {
                let parsed = JSON.parse(jsonMatch[0]);
                if (parsed.Result && typeof parsed.Result === "string") {
                  parsed = JSON.parse(parsed.Result);
                }
                return Response.json(parsed, { headers: corsHeaders });
              } catch { /* fall through */ }
            }
          }
        }

        // Couldn't parse — return raw stdout for debugging
        return Response.json(
          { error: "Could not parse CRE result", stdout: stdout.slice(-1000) },
          { status: 500, headers: corsHeaders }
        );

      } catch (err: any) {
        console.error(`[CRE Bridge] Error:`, err);
        return Response.json(
          { error: err.message || "Unknown error" },
          { status: 500, headers: corsHeaders }
        );
      }
    }

    // POST /nav — run basket-nav workflow
    if (url.pathname === "/nav" && req.method === "POST") {
      try {
        const body = await req.json() as {
          basketId: string | number;
          chainId?: number;
        };

        if (!body.basketId) {
          return Response.json(
            { error: "Missing basketId" },
            { status: 400, headers: corsHeaders }
          );
        }

        const chainSelectorName = body.chainId
          ? CHAIN_SELECTOR_MAP[body.chainId] || "ethereum-testnet-sepolia"
          : "ethereum-testnet-sepolia";
          console.log(`[CRE Bridge] Chain: ${body.chainId} → ${chainSelectorName}`);

        const payload = JSON.stringify({
            basketId: String(body.basketId),
            chainSelectorName,
        });

        console.log(`[CRE Bridge] Running basket-nav for basketId=${body.basketId}`);

        const proc = Bun.spawn(
          [
            "cre",
            "workflow",
            "simulate",
            "basket-nav",
            "--non-interactive",
            "--trigger-index",
            "0",
            "--http-payload",
            payload,
            "--target",
            "staging-settings",
          ],
          {
            cwd: CRE_PROJECT_DIR,
            stdout: "pipe",
            stderr: "pipe",
          }
        );

        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        const exitCode = await proc.exited;

        // Stream full CRE simulation output to bridge console
        if (stderr) stderr.split("\n").forEach(line => line.trim() && console.log(`  ${line}`));
        if (stdout) stdout.split("\n").forEach(line => line.trim() && console.log(`  ${line}`));
        console.log(`[CRE Bridge] basket-nav exit code: ${exitCode}`);

        if (exitCode !== 0) {
          return Response.json(
            { error: `CRE simulation failed (exit ${exitCode})`, stderr: stderr.slice(-500), stdout: stdout.slice(-500) },
            { status: 500, headers: corsHeaders }
          );
        }

        // Parse "Workflow Simulation Result:" from stdout
        const resultMatch = stdout.match(/Workflow Simulation Result:\s*([\s\S]*?)(?:\n\d{4}-|\n$|$)/);
        if (resultMatch) {
          let jsonStr = resultMatch[1].trim();
          try {
            let parsed = JSON.parse(jsonStr);
            if (parsed.Result && typeof parsed.Result === "string") {
              parsed = JSON.parse(parsed.Result);
            } else if (typeof parsed === "string") {
              parsed = JSON.parse(parsed);
            }
            console.log(`[CRE Bridge] NAV complete for basket "${parsed.basketName || body.basketId}": $${parsed.navUsd ?? "?"}/unit`);
            return Response.json(parsed, { headers: corsHeaders });
          } catch {
            const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              try {
                let parsed = JSON.parse(jsonMatch[0]);
                if (parsed.Result && typeof parsed.Result === "string") {
                  parsed = JSON.parse(parsed.Result);
                }
                return Response.json(parsed, { headers: corsHeaders });
              } catch { /* fall through */ }
            }
          }
        }

        return Response.json(
          { error: "Could not parse CRE result", stdout: stdout.slice(-1000) },
          { status: 500, headers: corsHeaders }
        );

      } catch (err: any) {
        console.error(`[CRE Bridge] Error:`, err);
        return Response.json(
          { error: err.message || "Unknown error" },
          { status: 500, headers: corsHeaders }
        );
      }
    }

    // POST /analyze — run basket-analysis workflow
    if (url.pathname === "/analyze" && req.method === "POST") {
      try {
        const body = await req.json() as {
          basketId: string | number;
          chainId?: number;
        };

        if (!body.basketId) {
          return Response.json(
            { error: "Missing basketId" },
            { status: 400, headers: corsHeaders }
          );
        }

        const chainSelectorName = body.chainId
          ? CHAIN_SELECTOR_MAP[body.chainId] || "ethereum-testnet-sepolia"
          : "ethereum-testnet-sepolia";
          console.log(`[CRE Bridge] Chain: ${body.chainId} → ${chainSelectorName}`);

        const payload = JSON.stringify({
          basketId: String(body.basketId),
          chainSelectorName,
        });

        console.log(`[CRE Bridge] Running basket-analysis for basketId=${body.basketId}`);

        const proc = Bun.spawn(
          [
            "cre",
            "workflow",
            "simulate",
            "basket-analysis",
            "--non-interactive",
            "--trigger-index",
            "0",
            "--http-payload",
            payload,
            "--target",
            "staging-settings",
          ],
          {
            cwd: CRE_PROJECT_DIR,
            stdout: "pipe",
            stderr: "pipe",
          }
        );

        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        const exitCode = await proc.exited;

        // Stream full CRE simulation output to bridge console
        if (stderr) stderr.split("\n").forEach(line => line.trim() && console.log(`  ${line}`));
        if (stdout) stdout.split("\n").forEach(line => line.trim() && console.log(`  ${line}`));
        console.log(`[CRE Bridge] basket-analysis exit code: ${exitCode}`);

        if (exitCode !== 0) {
          return Response.json(
            { error: `CRE simulation failed (exit ${exitCode})`, stderr: stderr.slice(-500), stdout: stdout.slice(-500) },
            { status: 500, headers: corsHeaders }
          );
        }

        // Parse "Workflow Simulation Result:" from stdout
        const resultMatch = stdout.match(/Workflow Simulation Result:\s*([\s\S]*?)(?:\n\d{4}-|\n$|$)/);
        if (resultMatch) {
          let jsonStr = resultMatch[1].trim();
          try {
            let parsed = JSON.parse(jsonStr);
            // Unwrap { Result: "..." } if double-encoded
            if (parsed.Result && typeof parsed.Result === "string") {
              parsed = JSON.parse(parsed.Result);
            } else if (typeof parsed === "string") {
              parsed = JSON.parse(parsed);
            }
            console.log(`[CRE Bridge] Analysis complete for basket "${parsed.basketName || body.basketId}"`);
            return Response.json(parsed, { headers: corsHeaders });
          } catch {
            const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              try {
                let parsed = JSON.parse(jsonMatch[0]);
                if (parsed.Result && typeof parsed.Result === "string") {
                  parsed = JSON.parse(parsed.Result);
                }
                return Response.json(parsed, { headers: corsHeaders });
              } catch { /* fall through */ }
            }
          }
        }

        return Response.json(
          { error: "Could not parse CRE result", stdout: stdout.slice(-1000) },
          { status: 500, headers: corsHeaders }
        );

      } catch (err: any) {
        console.error(`[CRE Bridge] Error:`, err);
        return Response.json(
          { error: err.message || "Unknown error" },
          { status: 500, headers: corsHeaders }
        );
      }
    }

    // POST /ccc-balances — proxy to CCC Private Token API (avoids browser CORS)
    if (url.pathname === "/ccc-balances" && req.method === "POST") {
      try {
        const body = await req.json();
        console.log(`[CRE Bridge] Proxying CCC /balances for ${body.account}`);

        const resp = await fetch("https://convergence2026-token-api.cldev.cloud/balances", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        const data = await resp.json();

        if (!resp.ok) {
          console.log(`[CRE Bridge] CCC API error: ${resp.status}`, data);
          return Response.json(data, { status: resp.status, headers: corsHeaders });
        }

        console.log(`[CRE Bridge] CCC balances: ${(data as any).balances?.length ?? 0} token(s)`);
        return Response.json(data, { headers: corsHeaders });
      } catch (err: any) {
        console.error(`[CRE Bridge] CCC proxy error:`, err);
        return Response.json(
          { error: err.message || "CCC proxy error" },
          { status: 500, headers: corsHeaders }
        );
      }
    }

    // POST /nav-ccc — run ccc-basket-nav workflow (ConfidentialHTTPClient)
    if (url.pathname === "/nav-ccc" && req.method === "POST") {
      try {
        const body = await req.json() as {
          basketId: string | number;
          chainId?: number;
        };

        if (!body.basketId) {
          return Response.json(
            { error: "Missing basketId" },
            { status: 400, headers: corsHeaders }
          );
        }

        const chainSelectorName = body.chainId
          ? CHAIN_SELECTOR_MAP[body.chainId] || "ethereum-testnet-sepolia"
          : "ethereum-testnet-sepolia";
        console.log(`[CRE Bridge] Chain: ${body.chainId} → ${chainSelectorName}`);

        const payload = JSON.stringify({
          basketId: String(body.basketId),
          chainSelectorName,
        });

        console.log(`[CRE Bridge] Running ccc-basket-nav (confidential) for basketId=${body.basketId}`);

        const proc = Bun.spawn(
          [
            "cre", "workflow", "simulate", "ccc-basket-nav",
            "--non-interactive", "--trigger-index", "0",
            "--http-payload", payload,
            "--target", "staging-settings",
          ],
          { cwd: CRE_PROJECT_DIR, stdout: "pipe", stderr: "pipe" }
        );

        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        const exitCode = await proc.exited;

        if (stderr) stderr.split("\n").forEach(line => line.trim() && console.log(`  ${line}`));
        if (stdout) stdout.split("\n").forEach(line => line.trim() && console.log(`  ${line}`));
        console.log(`[CRE Bridge] ccc-basket-nav exit code: ${exitCode}`);

        if (exitCode !== 0) {
          return Response.json(
            { error: `CRE simulation failed (exit ${exitCode})`, stderr: stderr.slice(-500), stdout: stdout.slice(-500) },
            { status: 500, headers: corsHeaders }
          );
        }

        const resultMatch = stdout.match(/Workflow Simulation Result:\s*([\s\S]*?)(?:\n\d{4}-|\n$|$)/);
        if (resultMatch) {
          let jsonStr = resultMatch[1].trim();
          try {
            let parsed = JSON.parse(jsonStr);
            if (parsed.Result && typeof parsed.Result === "string") {
              parsed = JSON.parse(parsed.Result);
            } else if (typeof parsed === "string") {
              parsed = JSON.parse(parsed);
            }
            console.log(`[CRE Bridge] CCC NAV complete for basket "${parsed.basketName || body.basketId}": $${parsed.navUsd ?? "?"}/unit`);
            return Response.json(parsed, { headers: corsHeaders });
          } catch {
            const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              try {
                let parsed = JSON.parse(jsonMatch[0]);
                if (parsed.Result && typeof parsed.Result === "string") {
                  parsed = JSON.parse(parsed.Result);
                }
                return Response.json(parsed, { headers: corsHeaders });
              } catch { /* fall through */ }
            }
          }
        }

        return Response.json(
          { error: "Could not parse CRE result", stdout: stdout.slice(-1000) },
          { status: 500, headers: corsHeaders }
        );
      } catch (err: any) {
        console.error(`[CRE Bridge] Error:`, err);
        return Response.json(
          { error: err.message || "Unknown error" },
          { status: 500, headers: corsHeaders }
        );
      }
    }

    // POST /analyze-ccc — run ccc-basket-analysis workflow (ConfidentialHTTPClient)
    if (url.pathname === "/analyze-ccc" && req.method === "POST") {
      try {
        const body = await req.json() as {
          basketId: string | number;
          chainId?: number;
        };

        if (!body.basketId) {
          return Response.json(
            { error: "Missing basketId" },
            { status: 400, headers: corsHeaders }
          );
        }

        const chainSelectorName = body.chainId
          ? CHAIN_SELECTOR_MAP[body.chainId] || "ethereum-testnet-sepolia"
          : "ethereum-testnet-sepolia";
        console.log(`[CRE Bridge] Chain: ${body.chainId} → ${chainSelectorName}`);

        const payload = JSON.stringify({
          basketId: String(body.basketId),
          chainSelectorName,
        });

        console.log(`[CRE Bridge] Running ccc-basket-analysis (confidential) for basketId=${body.basketId}`);

        const proc = Bun.spawn(
          [
            "cre", "workflow", "simulate", "ccc-basket-analysis",
            "--non-interactive", "--trigger-index", "0",
            "--http-payload", payload,
            "--target", "staging-settings",
          ],
          { cwd: CRE_PROJECT_DIR, stdout: "pipe", stderr: "pipe" }
        );

        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        const exitCode = await proc.exited;

        if (stderr) stderr.split("\n").forEach(line => line.trim() && console.log(`  ${line}`));
        if (stdout) stdout.split("\n").forEach(line => line.trim() && console.log(`  ${line}`));
        console.log(`[CRE Bridge] ccc-basket-analysis exit code: ${exitCode}`);

        if (exitCode !== 0) {
          return Response.json(
            { error: `CRE simulation failed (exit ${exitCode})`, stderr: stderr.slice(-500), stdout: stdout.slice(-500) },
            { status: 500, headers: corsHeaders }
          );
        }

        const resultMatch = stdout.match(/Workflow Simulation Result:\s*([\s\S]*?)(?:\n\d{4}-|\n$|$)/);
        if (resultMatch) {
          let jsonStr = resultMatch[1].trim();
          try {
            let parsed = JSON.parse(jsonStr);
            if (parsed.Result && typeof parsed.Result === "string") {
              parsed = JSON.parse(parsed.Result);
            } else if (typeof parsed === "string") {
              parsed = JSON.parse(parsed);
            }
            console.log(`[CRE Bridge] CCC Analysis complete for basket "${parsed.basketName || body.basketId}"`);
            return Response.json(parsed, { headers: corsHeaders });
          } catch {
            const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              try {
                let parsed = JSON.parse(jsonMatch[0]);
                if (parsed.Result && typeof parsed.Result === "string") {
                  parsed = JSON.parse(parsed.Result);
                }
                return Response.json(parsed, { headers: corsHeaders });
              } catch { /* fall through */ }
            }
          }
        }

        return Response.json(
          { error: "Could not parse CRE result", stdout: stdout.slice(-1000) },
          { status: 500, headers: corsHeaders }
        );
      } catch (err: any) {
        console.error(`[CRE Bridge] Error:`, err);
        return Response.json(
          { error: err.message || "Unknown error" },
          { status: 500, headers: corsHeaders }
        );
      }
    }

    return Response.json({ error: "Not found" }, { status: 404, headers: corsHeaders });
  },
});

console.log(`\n  🔗 CRE Bridge Server running on http://localhost:${PORT}`);
console.log(`  📁 CRE project dir: ${CRE_PROJECT_DIR}`);
console.log(`  📡 Endpoints: /verify, /nav, /analyze, /ccc-balances, /nav-ccc, /analyze-ccc`);
console.log(`  🧪 Test: curl http://localhost:${PORT}/health\n`);
