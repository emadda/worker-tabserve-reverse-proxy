import p from './../package.json';

import * as _ from "lodash";
import {encode, decode} from "@msgpack/msgpack";
import {v4 as uuidv4} from 'uuid';
import {dev_lock} from "./config";
import {is_ws_auth_valid, res_not_authorised, url_log} from "./util";
import p from "./../package.json";

// @see https://github.com/cloudflare/durable-objects-typescript-rollup-esm/tree/master/src
// In order for the workers runtime to find the class that implements
// our Durable Object namespace, we must export it from the root module.
export {REV_PROXY_DO} from './rev_proxy_do'


// Note: consumes the request body so it cannot be re-used.
const request_to_data = async (req: Request) => {
    const req_id = uuidv4();

    const {
        url,
        method,
        integrity,
        // @todo/low Add any other fields
    } = req;


    const headers = _.fromPairs([...req.headers.entries()]);
    const body_uint8 = new Uint8Array(await req.arrayBuffer());

    const o = {
        kind: "request",
        data: {
            req_id,
            url,
            method,
            integrity,
            headers,
            body: body_uint8
        }
    };

    return o;
}


const get_rev_proxy_do = async (env, id) => {
    const today_utc = (new Date()).toISOString().split("T")[0];

    // Use date to force the creation of a new DO in case the user has moved location (DOs stay in one region after they are created and never move).
    const id_do = env.REV_PROXY_DO.idFromName(`${id}/${today_utc}`);
    return env.REV_PROXY_DO.get(id_do);
}


// @todo/low Use `tldts` to extract the TLD and assert only one subdomain is provided (the API to add a server already does this).
const get_first_subdomain = (hostname) => {
    const [first, ...rest] = hostname.split(".");
    return first.trim();
}

// @todo/low Prevent users adding subdomains ending in `ws` or `api`
// - Temp fix: Do not allow ids of less than 4 chars.
// - Cloudflare TLS allows any first level subdomain, but you have to pay for subdomain levels >1.
const get_parts = (subdomain) => {

    // Internal action.
    // E.g: "some-user-chosen-id-ws"
    const m = subdomain.match(/^(?<id>.+)-(?<action>(ws|api))$/);
    if (m !== null) {
        return {
            id: m.groups.id,
            action: m.groups.action,
        }
    }

    return {
        id: subdomain.trim(),

        // Public URL.
        action: null
    };
};

const is_websocket_upgrade = (request) => {
    return request.headers.get('Upgrade') === "websocket";
}

// Ignore favicon in dev when loading from a browser.
const ignore_favicon = (request, env) => {
    if (dev_lock(env) && new URL(request.url).pathname.startsWith("/favicon.ico")) {
        return new Response(null, {status: 204});
    }
    return null;
}


export default {

    async fetch(
        request: Request,
        env: Env,
        ctx: ExecutionContext
    ): Promise<Response> {
        try {
            const url = new URL(request.url);
            const hostname = url.hostname;

            console.log(`fetch() index.ts started:`, url_log(request));

            // Use subdomain's instead of different workers to avoid issues running multiple workers locally in development.
            // - Worker to worker communication does not work (durable objects shared between workers via wrangler.toml, services), although these work in production.
            // - This simplifies access to the durable object.
            const subdomain = get_first_subdomain(hostname);
            if (subdomain === null) {
                return new Response(`Hostname must have only a first level subdomain like: 'first-subdomain.localhost'. Got hostname=${hostname}`, {status: 400})
            }

            const parts = get_parts(subdomain);
            console.log("Subdomain parts:", JSON.stringify(parts));

            const rev_proxy_do = await get_rev_proxy_do(env, parts.id);

            // Public: Incoming HTTP requests get forwarded over the active websocket to a client, which forwards them to a localhost server.
            // - The handler will wait for a response from the websocket, and then resolve with the response.
            // <id>.your-domain.com
            if (parts.action === null) {
                const obj = await request_to_data(request);
                const {data: {req_id}} = obj;
                const bytes: Uint8Array = encode(obj);

                console.log("Req ID created, forwarding request over WebSocket:", req_id);

                // @todo/low Block Googlebot from indexing content.

                // @see https://developers.cloudflare.com/workers/platform/compatibility-dates/#durable-object-stubfetch-requires-a-full-url
                return rev_proxy_do.fetch(`https://internal-only-domain/fwd/${req_id}`, {method: "POST", body: bytes});
            }


            // Private: A websocket connection that has msgpack-serialised-HTTP-requests forwarded over it to a client, which then sends back a msgpack-serialised response over the same websocket.
            // <id>-ws.your-domain.com
            if (parts.action === "ws") {
                if (!is_ws_auth_valid(env, request)) {
                    console.log("WS upgrade request not authorised, include header 'Authorization: Bearer x' and also set AUTH_TOKEN in the CF worker env to something longer than 40 chars.");
                    return res_not_authorised();
                }

                console.log("Upgrading WS");

                if (is_websocket_upgrade(request)) {
                    // Only allow fetch /fwd privately (avoid any users being able to contact any ip:port from the users localhost).
                    return rev_proxy_do.fetch(request);
                }
                return new Response('Expected Upgrade: websocket', {status: 426});
            }


            // Public: An HTTP API for meta data.
            // <id>-api.your-domain.com
            if (parts.action === "api") {
                if (request.method === "GET" && url.pathname === "/meta") {
                    return get_meta();
                }
            }

        } catch (e) {
            console.error(e);
            throw e;
        }


        console.error("Unhandled return, index.ts");
        return new Response('Not found.', {status: 404});
    },
}

const get_meta = () => {
    const meta = {
        version: p.version
    };

    const res = {
        ok: true,
        data: meta
    };

    return new Response(JSON.stringify(res, null, 4), {
        status: 200,
        headers: {
            'content-type': 'application/json',
        }
    })
}


interface Env {
    REV_PROXY_DO: DurableObjectNamespace,
}

