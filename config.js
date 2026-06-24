'use strict';

const DEFAULT_ADAPTER = process.env.CONDUCTOR_DEFAULT_ADAPTER || 'codex-code';
const PRODUCT_NAME = process.env.CONDUCTOR_PRODUCT_NAME || 'Codex Conductor';
const CLI_NAME = process.env.CONDUCTOR_CLI_NAME || 'codex-conductor';

module.exports = { DEFAULT_ADAPTER, PRODUCT_NAME, CLI_NAME };
