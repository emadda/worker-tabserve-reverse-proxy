# Tabserve Reverse Proxy

This is a [Cloudflare worker](https://workers.cloudflare.com/) that works as reverse proxy for [Tabserve](https://tabserve.dev).

Tabserve is a web app that uses browser web workers as a reverse proxy.

This enables you to have a public HTTPS url and route it to a http://localhost:1234 web server running on your computer.

See [Tabserve](https://tabserve.dev) for more details.


## Deploy this worker to your Cloudflare account.

### A. Deploying the worker

- 1 . Sign up for a CF account.
- 2 . `git clone https://github.com/emadda/worker-tabserve-reverse-proxy`
- 3 . `npm install`
- 4 . Set `AUTH_TOKEN` to a unique string over 40 chars in `wrangler.toml`
- 5 . Deploy: `wrangler deploy`


### B. Setting up your domain

- 1 . Buy a domain (from either Cloudflare or Namecheap).
- 2 . Add `your-domain.com` to Cloudflare DNS.
- 3 . Add a CNAME record:


| Type  | Name | Content                     | Proxy Status |
|-------|------|-----------------------------|--------------|
| CNAME | *    | can.be.anything.example.com | Proxied      |

Because this is "Proxied", the `Content` target is ignored and CF DNS returns the IP of your worker.

- 4 . Add a `Workers Routes` to your domain via the menu on the left when viewing your domain:
	- `(*.your-domain.com/*) => (worker-tabserve-reverse-proxy)`


After setting up A and B, you can use Tabserve to route requests to a localhost server.

- You will need to paste your `AUTH_TOKEN` into the Tabserve config.
- When adding a server, use any `<id>.your-domain.com`, where `<id>` is any subdomain you desire.


## How this worker works.

- It handles two subdomains:
	- 1 . `<id>.your-domain.com`
		- This is the public URL.


	- 2 . `<id>-ws.your-domain.com`
		- This is a websocket server that the Tabserve web app connects to.
		- The Tabserve web app receives the serialized HTTP request, routes it to a localhost server, then sends back the serialized response over the same websocket connection.

- Each unique subdomain `<id>` gets its own Durable Object.
	- The hibernation API is used for WebSockets which should allow Tabserve to listen for requests constantly whilst only paying for CPU time when active.
	- You can switch off `<id>`s in the Tabserve UI which disconnects the WebSocket preventing any charge.




## Note.

- Workers are optimized for API and HTML traffic, so large files are likely to block the worker event loop. Consider CF R2 for large files.

## To do

- [ ] Support WebSocket connections to the the public URL.
- [ ] Track request stats.





If you have any issues or feedback, please create an issue on the [Tabserve issues GitHub](https://github.com/emadda/tabserve).





