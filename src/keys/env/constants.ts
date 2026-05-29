/**
 * EnvKeyProvider constants.
 *
 * The env-var name is the public contract — it's what users set in their shell, in
 * their docker-compose, in their AI client's launch env. Pulling it into a constants
 * file keeps the impl free of magic strings and makes the public surface searchable.
 */

/** Environment variable that holds the base64-encoded 32-byte AES key. */
export const ENV_VAR = 'MEMENTOS_RAW_KEY'
