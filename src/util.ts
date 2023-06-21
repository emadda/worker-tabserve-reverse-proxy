import * as _ from "lodash";
import {get_config_from_env} from "./config";

// E.g. `2023-05-03 19:21`
const get_iso_date_min = () => (new Date()).toISOString().match(/^(?<min>.+):/).groups.min.replace("T", " ")


// Note: the web browser `WebSocket` API does not allow setting Auth headers or using username/password in the URL.
// - Fallback to query param.
const is_ws_auth_valid = (env, req) => {
    const config_env = get_config_from_env(env);
    const allowed_tokens = [config_env.auth_token];

    // const x = req.headers.get("Authorization");
    // console.log(JSON.stringify([...req.headers.entries()], null, 4));

    const u = new URL(req.url);
    const auth_token = u.searchParams.get("auth_token");

    if (!_.isString(auth_token)) {
        return false;
    }

    return allowed_tokens.includes(auth_token);
}

const res_not_authorised = () => {
    return json_res({
        ok: false,
        msg: "Auth invalid. Include `Authorization: Bearer x` token and set the auth token as an env var."
    }, {status: 401});
}

const json_res = (obj, opts = {}) => {
    const o = _.merge(
        {
            headers: {
                'content-type': 'application/json',
                // ...cors_headers
            }
        },
        opts
    );

    const r = new Response(JSON.stringify(obj), o);
    return r;
};

const sleep = async (ms) => {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// A one line string for logging the URL being requested, excluding query params.
//
// E.g. `GET http://rfnp3.localhost:8701/x.json`
const url_log = (request) => {
    const url = new URL(request.url);
    return `${request.method} ${url.protocol}//${url.host}${url.pathname}`;
}

export {
    get_iso_date_min,
    is_ws_auth_valid,
    res_not_authorised,
    json_res,
    sleep,
    url_log
}