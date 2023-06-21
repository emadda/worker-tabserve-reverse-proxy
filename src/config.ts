// @see https://developers.cloudflare.com/workers/wrangler/configuration/#environmental-variables

import * as _ from "lodash";

const is_dev = (env) => {
    return get_config_from_env(env).env === "dev";
}

// Local certain features in dev to make testing easier.
const dev_lock = (env) => {
    return (
        is_dev(env) && true
    )
}

const config = {};

const get_config_from_env = (env) => {
    if (!("ENV" in env) || !["dev", "prod"].includes(env.ENV)) {
        console.error("ENV must be set to `dev` or `prod` in wrangler.toml vars or in the file `.dev.vars` in the project root for dev.");
        throw Error("ENV must be set to `dev` or `prod` in wrangler.toml vars or in the file `.dev.vars` in the project root for dev.");
    }


    if (!("AUTH_TOKEN" in env) || !(_.isString(env.AUTH_TOKEN) && env.AUTH_TOKEN.length >= 40)) {
        console.error("AUTH_TOKEN must be set to a string equal or over 40 chars in length in wrangler.toml vars or in the file `.dev.vars` in the project root for dev.");
        throw Error("AUTH_TOKEN must be set to a string equal or over 40 chars in length in wrangler.toml vars or in the file `.dev.vars` in the project root for dev.");
    }

    return {
        env: env.ENV,
        auth_token: env.AUTH_TOKEN,
    }
}


export {
    is_dev,
    dev_lock,
    config,
    get_config_from_env
}