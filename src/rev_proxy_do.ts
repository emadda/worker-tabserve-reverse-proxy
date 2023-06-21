import * as _ from "lodash";
import {encode, decode} from "@msgpack/msgpack";
import {is_ws_auth_valid, res_not_authorised, sleep, url_log} from "./util";


const is_websocket_upgrade = (request) => {
    return request.headers.get('Upgrade') === "websocket";
}

// API is in beta but does not work in workerd.
// - https://github.com/cloudflare/workerd/issues/736

// WebSocket Hibernation API.
// - Durable Objects are not charged for idle WebSockets.
// - @see https://developers.cloudflare.com/workers/runtime-apis/durable-objects/#websockets-hibernation-api-beta
// - @see https://github.com/cloudflare/workers-chat-demo/tree/hibernation
const get_ws_config_from_env = (env) => {
    // Hibernation only works in prod, not on a local workerd.
    let USE_WS_HIBERNATION = false;

    if ("USE_WS_HIBERNATION" in env) {
        USE_WS_HIBERNATION = env["USE_WS_HIBERNATION"].toString() === "1";
    }


    return {
        USE_WS_HIBERNATION
    }
}


const get_today_and_next_utc = () => {
    const utc_day = (new Date()).toISOString().split("T")[0];
    const next = new Date(utc_day);
    next.setDate(next.getDate() + 1);
    return {
        today_utc: utc_day,
        next_day_utc: next.toISOString().split("T")[0]
    }
}

const data_to_response = (data) => {
    const res = new Response(data.body, {
        status: data.status,
        headers: data.headers
    });

    return res;
}

// @todo/low create MSG class.
const kinds = {
    // Contains complete body.
    RESPONSE: "response",

    // Contains stream of bytes.
    RESPONSE_PART_START: "response_part_start",
    RESPONSE_PART: "response_part",
    RESPONSE_PART_END: "response_part_end",
}


export class REV_PROXY_DO {
    state: DurableObjectState
    ws = null

    waiting = {}

    USE_WS_HIBERNATION = false

    constructor(state: DurableObjectState, env: Env) {
        this.env = env;
        this.state = state;


        this.USE_WS_HIBERNATION = get_ws_config_from_env(env).USE_WS_HIBERNATION;
        console.log({USE_WS_HIBERNATION: this.USE_WS_HIBERNATION});

        if (this.USE_WS_HIBERNATION) {
            // Connect all persisted ws `server` ends to this JS runtime.
            const persisted_websocket_ends = state.getWebSockets();
            if (persisted_websocket_ends.length > 0) {
                this.ws = persisted_websocket_ends[0];
            }

            if (persisted_websocket_ends.length > 1) {
                console.error("More than one ws persisted - there should only be one WebSocket persisted as every REV_PROXY_DO instance services only one PUB URL => REV_PROXY_DO => WS chain. Closing extra WebSockets.");
                for (const ws of persisted_websocket_ends.slice(1)) {
                    ws.close(1002, "Only one WS per REV_PROXY_DO instance allowed - this was one of the extra ones.");
                }
            }
        }

        this.set_alarm_for_next_day();
    }


    async set_alarm_for_next_day() {
        const d = get_today_and_next_utc();
        let first_started_on = await this.state.storage.get("first_started_on");
        if (first_started_on === undefined) {
            await this.state.storage.put("first_started_on", d);
            await this.state.storage.setAlarm(new Date(d.next_day_utc));
        }
    }

    // Disconnect ws to force re-connect to a new DO which forces re-locating it closest to the user (in case they have moved location).
    // E.g. If a dev travels to a new location they should not connect to the DO at their old location.
    async alarm() {
        const first_started_on = await this.state.storage.get("first_started_on");

        // When: Hibernated WS restored via constructor.
        if (this.ws !== null) {
            const msg = "Disconnecting ws to force a reconnect to a new Durable Object in case the user has moved geographically. Durable Objects stay in one region once created, so new ones must be created to place the new DO closest to the user.";
            console.log(msg, first_started_on);
            this.ws.close(1002, msg);
        }
    }

    wait_for_response_from_ws(x) {
        this.waiting[x.req_id] = x;
    }


    // @todo/med Is it possible that response bytes can be returned in the incorrect order? Are writer locks queued in the order they were requested?
    // @todo/med Large downloads seem very slow (localhost -> ws messages occur very quickly, but then ws -> Response stream seems to have a bottleneck somewhere).
    async on_ws_message(msgpack_bytes) {
        const msg = decode(msgpack_bytes);
        const {kind, data} = msg;

        const has_req_id = (kind) => kind in [kinds.RESPONSE, kinds.RESPONSE_PART_START, kinds.RESPONSE_PART, kinds.RESPONSE_PART_END];
        if (has_req_id(kind)) {
            if (!(data.req_id in this.waiting)) {
                // When: Durable object restarts (websocket disconnect), and tab sends response back over websocket.
                console.error(`Request ID ${data.req_id} does not have a waiting promise.`);
                return;
            }
        }

        // @todo/med workerd run locally crashes after around 5 24MB transfers. Is everything correctly GC'd?

        // Avoid `switch` as it does not have block scoped variables.
        if (kind === kinds.RESPONSE) {
            const {req_id} = data;

            // this.waiting[req_id].resolve(new Response(msgpack_bytes));
            this.waiting[req_id].resolve(data_to_response(data));

            // Note: The calling function should have a reference to this promise, so it will not be GC'd until the value is used.
            delete this.waiting[req_id];

        } else if (kind === kinds.RESPONSE_PART_START) {
            const {req_id} = data;
            const x = this.waiting[req_id];

            // @see https://developers.cloudflare.com/workers/learning/using-streams/
            const transform_stream = new TransformStream();
            const response = new Response(transform_stream.readable, {
                status: data.status,
                headers: data.headers
            });

            x.response = response;
            x.transform_stream = transform_stream;

            const writer = transform_stream.writable.getWriter();
            await writer.write(data.bytes);
            writer.releaseLock();

            // A "Response" is resolved, but the body will continue to be streamed.
            x.resolve(response);

        } else if (kind === kinds.RESPONSE_PART) {
            const {req_id} = data;
            const x = this.waiting[req_id];

            const writer = x.transform_stream.writable.getWriter();
            // @todo/low handle error (when the stream has been closed).
            await writer.write(data.bytes);
            writer.releaseLock();

        } else if (kind === kinds.RESPONSE_PART_END) {
            const {req_id} = data;
            const x = this.waiting[req_id];

            const writer = x.transform_stream.writable.getWriter();
            // @todo/low handle error (when the stream has been closed).
            await writer.write(data.bytes);
            await writer.close();

            // Note: The calling function should have a reference to this promise, so it will not be GC'd until the value is used.
            delete this.waiting[req_id];
        } else {
            throw Error(`Unknown msgpack msg kind: ${kind}`);
        }

    }

    // Handle HTTP requests from clients.
    async fetch(request: Request) {
        const url = new URL(request.url);
        try {
            console.log(`fetch() rev_proxy_do.ts started:`, url_log(request));

            // Worker forwards upgrade from public request, durable object keeps server side websocket in state.
            if (is_websocket_upgrade(request)) {
                console.log("WS upgrade received.");

                if (!is_ws_auth_valid(this.env, request)) {
                    console.log("WS upgrade request not authorised, include header 'Authorization: Bearer x' and also set AUTH_TOKEN in the CF worker env to something longer than 40 chars.");
                    return res_not_authorised();
                }

                if (this.ws !== null) {
                    // @todo/low Allow the last connection attempt to replace the current ws connection.
                    // @todo/low There seems to be an issue with a hibernated WebSocket, where the DO holds on to a closed ws connection so does not accept any more connections.
                    console.log(`Cannot upgrade to a websocket as there is a websocket already connected.`);
                    return new Response(`Cannot upgrade to a websocket as there is a websocket already connected.`, {status: 400});
                }

                // @todo/low In prod, force wss:// (TLS).
                if (this.USE_WS_HIBERNATION) {
                    console.log("Using ws hibernation API.");
                    return this.create_and_persist_a_single_global_ws();
                } else {
                    return this.start_websocket();
                }

            }


            const fwd_m = url.pathname.match(/^\/fwd\/(?<req_id>.+?)\/?$/);

            // Forward request from public URL over websocket to localhost.
            // - Note: this should only be callable privately from the worker.
            if (fwd_m !== null) {
                const {req_id} = fwd_m.groups;


                // If the tab is in the process of reconnecting do not drop requests.
                // - E.g. Wifi drops on dev's laptop.
                const retry_for_seconds = 10;
                let retried_seconds = 0;
                while (this.ws === null) {
                    console.log("No ws to forward request over, waiting for client ws to connect.", req_id);
                    if (retried_seconds >= retry_for_seconds) {
                        // No tab connected.
                        const msg = `HTTP 502. No websocket connection to forward over. Dropping request. Ensure that your tab is open, has an internet connection and the server is on.`;
                        console.log(msg, request.url);
                        return new Response(msg, {status: 502});
                    }

                    await sleep(1000);
                    retried_seconds += 1;
                }


                let resolve, reject;
                const p = new Promise((a, b) => {
                    resolve = a;
                    reject = b;
                });

                this.wait_for_response_from_ws({
                    req_id,
                    p,
                    resolve,
                    reject,
                    response: null,
                    transform_stream: null
                });

                this.ws.send(await request.arrayBuffer());
                console.log("Sent over ws, waiting for response.", req_id);

                return p;
            }

        } catch (e) {
            console.error(e);
            throw e;
        }

        console.error("Unhandled return, rev_proxy_do.ts");
    }


    create_and_persist_a_single_global_ws() {
        const ws_pair = new WebSocketPair();
        const [client, server] = Object.values(ws_pair);

        console.log("acceptWebSocket() start");

        // - Connect `server` ws end to this JS instance.
        // - Hibernation: allow `server` ws end to persist restarts.
        this.state.acceptWebSocket(server);
        this.ws = server;


        console.log("acceptWebSocket() completed");


        return new Response(null, {
            status: 101,
            webSocket: client,
        });
    }

    // Messages are from the tab and contain the HTTP response to return.
    async webSocketMessage(ws, msg) {
        const not_string = (typeof msg !== "string");

        if (not_string) {
            this.on_ws_message(msg);
        } else {
            console.log("String received: ", msg);
        }
    }

    async webSocketClose(ws, code, reason, wasClean) {
        console.log("ws.error", {code, reason, wasClean});
        this.ws = null;
    }

    async webSocketError(ws, error) {
        console.log(`ws.close ${new Date()}`, error);
        this.ws = null;
    }


    start_websocket() {
        console.log("New websocket pair.");
        const webSocketPair = new WebSocketPair();
        const [client, server] = Object.values(webSocketPair);

        // Assumption: this tells the runtime this ws socket will be terminated in JS (used as a server).
        // - This must keep a reference to `server` var and keep the web socket running, as it is not garbage collected and closed at the end of this function.
        server.accept();

        server.addEventListener('message', (e) => {
            const not_string = (typeof e.data !== "string");

            if (not_string) {
                // Receiving WS message limit = 1MB.
                this.on_ws_message(e.data);
            } else {
                console.log("String received: ", e.data);
            }
        });

        server.addEventListener('error', (event) => {
            console.log("ws.error", event);
            this.ws = null;
        });
        server.addEventListener('close', (event) => {
            console.log(`ws.close ${new Date()}`, event);
            this.ws = null;
        });

        server.send("Connected.");

        this.ws = server;
        return new Response(null, {
            status: 101,
            webSocket: client,
        });
    }
}


interface Env {
}