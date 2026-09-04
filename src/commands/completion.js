/**
 * Nansen CLI - shell completion generator
 *
 * `nansen completion <bash|zsh|fish>` prints a completion script built from
 * src/schema.json, the same source of truth `nansen schema` and `--help` read.
 * Generating instead of checking in three hand-written scripts is what keeps
 * completions from drifting the moment a command or flag is added.
 *
 * Purely local: no disk writes, no network calls.
 */

import { CommandError } from '../api.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const schemaDefinition = require('../schema.json');
const { version: VERSION } = require('../../package.json');

export const COMPLETION_SHELLS = ['bash', 'zsh', 'fish'];

/**
 * Commands the CLI dispatches that schema.json does not describe. Adding them
 * to schema.json instead would change `nansen logout --help` (the schema help
 * path runs before the hand-written text), so they are declared here.
 * completion.test.js fails if a new top-level command appears in neither place.
 */
export const UNSCHEMA_COMMANDS = {
  login: {
    description: 'Save your Nansen API key',
    options: {
      'api-key': { type: 'string', description: 'API key (recorded in shell history — prefer --human)' },
      human: { type: 'boolean', description: 'Prompt for the key interactively' },
    },
  },
  logout: { description: 'Remove the saved API key' },
  schema: {
    description: 'Print the JSON schema for every command',
    options: { full: { type: 'boolean', description: 'Verbose schema instead of the compact listing' } },
  },
  cache: {
    description: 'API response cache maintenance',
    subcommands: { clear: { description: 'Clear all cached responses' } },
  },
  changelog: {
    description: 'Show release history',
    options: { since: { type: 'string', description: 'Only show versions at or above this one' } },
  },
  help: { description: 'Show the top-level help' },
};

/**
 * Deprecated top-level aliases still routed by runCLI. Left out on purpose:
 * completion is a discoverability surface, and suggesting `nansen token ...`
 * teaches the spelling we are trying to retire.
 */
export const EXCLUDED_COMMANDS = new Set([
  'smart-money', 'profiler', 'token', 'search', 'portfolio', 'points', 'prediction-market',
  'quote', 'execute',
  // Undocumented top-level alias of `trade bridge-status`: reachable because
  // runCLI spreads buildTradingCommands over the root, absent from HELP.
  'bridge-status',
]);

/**
 * Long flags parseArgs treats as valueless but schema.json does not type as
 * boolean (output flags that live only in the parser). Single-dash tokens
 * (-p, -h, -5) never take a value in parseArgs, so the walkers treat every one
 * as valueless without a list. The walker needs a *superset* of the real
 * valueless flags: an extra name here is harmless (the following word is
 * checked against the subcommand table anyway), a missing one makes the walker
 * swallow a real subcommand.
 */
const EXTRA_VALUELESS = ['help', 'version', 'cache', 'no-cache', 'stream', 'enrich', 'full', 'human'];

// Command, subcommand, option and enum tokens are interpolated straight into
// shell source. Anything that is not a bare word is dropped rather than escaped
// — a schema entry with a space or a quote in its *name* is a bug, not input we
// should try to render.
const SAFE_TOKEN = /^[A-Za-z0-9_.:@+-]+$/;

const MAX_DESC = 72;

/** One-line, length-capped description safe to sit inside a quoted shell string. */
export function shortDesc(text) {
  if (!text) return '';
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > MAX_DESC ? `${flat.slice(0, MAX_DESC - 1).trimEnd()}…` : flat;
}

function safeList(values) {
  return values.map(String).filter(v => SAFE_TOKEN.test(v));
}

/**
 * A boolean option never consumes the next word — unless it also declares an
 * enum, which means it accepts an explicit value (`--neg-risk true`, resolved
 * by resolveBooleanOption). Those stay value-taking so the enum is offered
 * after them and the walker skips the value.
 */
function isValueless(opt) {
  return opt.type === 'boolean' && !Array.isArray(opt.enum);
}

/**
 * Values to offer after an option. Explicit `enum` first; `--chain` under the
 * research tree falls back to schema.chains, which is exactly the list the
 * research endpoints accept. Trade/bridge chains are narrower and are left to
 * their own enums rather than guessed at.
 */
function optionValues(path, name, opt, schema) {
  if (Array.isArray(opt.enum)) return safeList(opt.enum);
  if (name === 'chain' && path.split(' ')[0] === 'research') return safeList(schema.chains || []);
  return [];
}

/**
 * Flatten the schema into one node per command path:
 *   { path: 'research token', subcommands: [...], options: [...], args: [...] }
 * The root node has path '' and every top-level command as its subcommands.
 * `args` holds the enum values of a command's positional arguments (schema
 * `args: [{ name, enum }]`); they are offered like subcommands but never
 * extend the command path.
 */
export function buildCompletionSpec({ schema = schemaDefinition, version = VERSION } = {}) {
  const nodes = [];
  const valueless = new Set(EXTRA_VALUELESS);

  const visit = (path, node) => {
    const subEntries = Object.entries(node.subcommands || {})
      .filter(([name]) => SAFE_TOKEN.test(name) && !(path === '' && EXCLUDED_COMMANDS.has(name)));
    const options = [];
    for (const [name, opt] of Object.entries(node.options || {})) {
      if (!SAFE_TOKEN.test(name)) continue;
      if (isValueless(opt)) valueless.add(name);
      options.push({
        name: `--${name}`,
        description: shortDesc(opt.description),
        values: optionValues(path, name, opt, schema),
      });
    }
    nodes.push({
      path,
      subcommands: subEntries.map(([name, sub]) => ({ name, description: shortDesc(sub.description) })),
      options,
      args: safeList((node.args || []).flatMap(a => (Array.isArray(a.enum) ? a.enum : []))),
    });
    for (const [name, sub] of subEntries) visit(path ? `${path} ${name}` : name, sub);
  };

  visit('', { subcommands: { ...schema.commands, ...UNSCHEMA_COMMANDS } });

  const globalOptions = Object.entries(schema.globalOptions || {})
    .filter(([name]) => SAFE_TOKEN.test(name))
    .map(([name, opt]) => {
      if (isValueless(opt)) valueless.add(name);
      return {
        name: `--${name}`,
        description: shortDesc(opt.description),
        values: Array.isArray(opt.enum) ? safeList(opt.enum) : [],
      };
    });
  globalOptions.push({ name: '--help', description: 'Show help for this command', values: [] });

  return {
    version,
    nodes,
    globalOptions,
    valuelessFlags: [...valueless].sort().map(f => `--${f}`),
  };
}

// ============= Shell quoting =============

// Every interpolated token is SAFE_TOKEN or a shortDesc string, so the only
// metacharacter that can reach these is a quote inside a description.
const dq = s => `"${s}"`;                                        // bash: tokens only
const sq = s => `'${String(s).replace(/'/g, "'\\''")}'`;         // bash/zsh
const fq = s => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`; // fish

function header(shell, version, install) {
  return [
    `# nansen ${shell} completion — generated by \`nansen completion ${shell}\` (nansen-cli v${version}).`,
    '# Regenerate after upgrading the CLI; do not edit by hand.',
    ...install.map(line => `# ${line}`),
  ].join('\n');
}

/** Group (path, option) pairs that share an identical value list into one case arm. */
function valueGroups(nodes) {
  const groups = new Map();
  for (const node of nodes) {
    for (const opt of node.options) {
      if (!opt.values.length) continue;
      const key = opt.values.join(' ');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(`${node.path}|${opt.name}`);
    }
  }
  return groups;
}

// ============= bash =============

export function generateBash(spec) {
  const { nodes, globalOptions, valuelessFlags, version } = spec;

  const subArms = nodes
    .filter(n => n.subcommands.length)
    .map(n => `    ${dq(n.path)}) echo ${dq(n.subcommands.map(s => s.name).join(' '))} ;;`);

  const optArms = nodes
    .filter(n => n.options.length)
    .map(n => `    ${dq(n.path)}) echo ${dq(n.options.map(o => o.name).join(' '))} ;;`);

  const valArms = [...valueGroups(nodes)].map(([values, keys]) =>
    `    ${keys.map(dq).join('|')}) echo ${dq(values)} ;;`);

  const argArms = nodes
    .filter(n => n.args.length)
    .map(n => `    ${dq(n.path)}) echo ${dq(n.args.join(' '))} ;;`);

  return `${header('bash', version, [
    'Install:  eval "$(nansen completion bash)"        # add to ~/.bashrc',
    '     or:  nansen completion bash > /etc/bash_completion.d/nansen',
  ])}

# Options that never consume the following word. Used to tell an option's value
# apart from a subcommand while walking the command line. A single-dash token
# never takes a value; only --long options need the lookup.
_nansen_is_flag() {
  case "$1" in
    --*) ;;
    *) return 0 ;;
  esac
  case " ${valuelessFlags.join(' ')} " in
    *" $1 "*) return 0 ;;
  esac
  return 1
}

_nansen_subs() {
  case "$1" in
${subArms.join('\n')}
  esac
}

_nansen_opts() {
  case "$1" in
${optArms.join('\n')}
  esac
}

_nansen_values() {
  case "$1|$2" in
${valArms.join('\n')}
  esac
}

# Positional argument values; offered alongside subcommands, never part of the path.
_nansen_args() {
  case "$1" in
${argArms.join('\n')}
  esac
}

_nansen_global_opts() {
  echo ${dq(globalOptions.map(o => o.name).join(' '))}
}

_nansen_has_sub() {
  case " $(_nansen_subs "$1") " in
    *" $2 "*) return 0 ;;
  esac
  return 1
}

_nansen_complete() {
  local cur prev path word i
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev=""
  [ "$COMP_CWORD" -gt 0 ] && prev="\${COMP_WORDS[COMP_CWORD-1]}"

  # Rebuild the command path: a bare word only extends it when it is a known
  # subcommand there, so option values and positionals are ignored.
  path=""
  i=1
  while [ "$i" -lt "$COMP_CWORD" ]; do
    word="\${COMP_WORDS[i]}"
    case "$word" in
      -*)
        _nansen_is_flag "$word" || i=$((i + 1))
        ;;
      *)
        if _nansen_has_sub "$path" "$word"; then
          if [ -z "$path" ]; then path="$word"; else path="$path $word"; fi
        fi
        ;;
    esac
    i=$((i + 1))
  done

  case "$cur" in
    -*)
      COMPREPLY=( $(compgen -W "$(_nansen_opts "$path") $(_nansen_global_opts)" -- "$cur") )
      return 0
      ;;
  esac

  case "$prev" in
    -*)
      if ! _nansen_is_flag "$prev"; then
        COMPREPLY=( $(compgen -W "$(_nansen_values "$path" "$prev")" -- "$cur") )
        return 0
      fi
      ;;
  esac

  COMPREPLY=( $(compgen -W "$(_nansen_subs "$path") $(_nansen_args "$path")" -- "$cur") )
  return 0
}

complete -F _nansen_complete nansen
`;
}

// ============= zsh =============

function zshItems(items) {
  // _describe reads "value:description" and splits on the first colon.
  return items.map(({ name, description }) =>
    sq(description ? `${name.replace(/:/g, '\\:')}:${description}` : name.replace(/:/g, '\\:'))
  ).join(' ');
}

export function generateZsh(spec) {
  const { nodes, globalOptions, valuelessFlags, version } = spec;

  const subArms = nodes
    .filter(n => n.subcommands.length)
    .map(n => `    ${sq(n.path)}) _nansen_reply=( ${zshItems(n.subcommands)} ) ;;`);

  const optArms = nodes
    .filter(n => n.options.length)
    .map(n => `    ${sq(n.path)}) _nansen_reply=( ${zshItems(n.options)} ) ;;`);

  const valArms = [...valueGroups(nodes)].map(([values, keys]) =>
    `    ${keys.map(sq).join('|')}) _nansen_reply=( ${values.split(' ').map(sq).join(' ')} ) ;;`);

  const argArms = nodes
    .filter(n => n.args.length)
    .map(n => `    ${sq(n.path)}) _nansen_reply=( ${n.args.map(sq).join(' ')} ) ;;`);

  return `#compdef nansen
${header('zsh', version, [
    'Install:  nansen completion zsh > "${fpath[1]}/_nansen" && compinit',
    '     or:  eval "$(nansen completion zsh)"              # in ~/.zshrc, after compinit',
  ])}

# A single-dash token never takes a value; only --long options need the lookup.
_nansen_is_flag() {
  case "$1" in
    --*) ;;
    *) return 0 ;;
  esac
  case " ${valuelessFlags.join(' ')} " in
    *" $1 "*) return 0 ;;
  esac
  return 1
}

# Each table fills the shared _nansen_reply array with "value:description" items.
_nansen_subs() {
  _nansen_reply=()
  case "$1" in
${subArms.join('\n')}
  esac
}

_nansen_opts() {
  _nansen_reply=()
  case "$1" in
${optArms.join('\n')}
  esac
}

_nansen_values() {
  _nansen_reply=()
  case "$1|$2" in
${valArms.join('\n')}
  esac
}

# Positional argument values; offered alongside subcommands, never part of the path.
_nansen_args() {
  _nansen_reply=()
  case "$1" in
${argArms.join('\n')}
  esac
}

_nansen_global_opts() {
  _nansen_reply=( ${zshItems(globalOptions)} )
}

_nansen_has_sub() {
  local item
  _nansen_subs "$1"
  for item in "\${_nansen_reply[@]}"; do
    [[ "\${item%%:*}" == "$2" ]] && return 0
  done
  return 1
}

_nansen() {
  # Not "path": zsh ties that array to PATH, and a local by that name would
  # empty PATH for the duration of every completion.
  local -a _nansen_reply all
  local cmdpath="" cur prev word
  local -i i

  cur="\${words[CURRENT]}"
  prev=""
  (( CURRENT > 1 )) && prev="\${words[CURRENT-1]}"

  # See the bash script: a bare word extends the path only where it is a real
  # subcommand, which keeps option values and positionals out of it.
  for (( i = 2; i < CURRENT; i++ )); do
    word="\${words[i]}"
    if [[ "$word" == -* ]]; then
      _nansen_is_flag "$word" || (( i++ ))
      continue
    fi
    if _nansen_has_sub "$cmdpath" "$word"; then
      if [[ -z "$cmdpath" ]]; then cmdpath="$word"; else cmdpath="$cmdpath $word"; fi
    fi
  done

  if [[ "$cur" == -* ]]; then
    _nansen_opts "$cmdpath"
    all=( "\${_nansen_reply[@]}" )
    _nansen_global_opts
    all+=( "\${_nansen_reply[@]}" )
    _nansen_reply=( "\${all[@]}" )
    _describe -t options 'option' _nansen_reply
    return
  fi

  if [[ "$prev" == -* ]] && ! _nansen_is_flag "$prev"; then
    _nansen_values "$cmdpath" "$prev"
    (( \${#_nansen_reply[@]} )) && _describe -t values 'value' _nansen_reply
    return
  fi

  local ret=1
  _nansen_subs "$cmdpath"
  (( \${#_nansen_reply[@]} )) && _describe -t commands 'command' _nansen_reply && ret=0
  _nansen_args "$cmdpath"
  (( \${#_nansen_reply[@]} )) && _describe -t arguments 'argument' _nansen_reply && ret=0
  return ret
}

if [[ "$funcstack[1]" == "_nansen" ]]; then
  _nansen "$@"
else
  compdef _nansen nansen
fi
`;
}

// ============= fish =============

function fishItems(items) {
  // printf reuses the format string for every remaining pair, so one call emits
  // the whole table as fish's "value<TAB>description" completion format.
  return items.map(({ name, description }) => `${fq(name)} ${fq(description)}`).join(' ');
}

export function generateFish(spec) {
  const { nodes, globalOptions, valuelessFlags, version } = spec;

  const subArms = nodes
    .filter(n => n.subcommands.length)
    .map(n => `        case ${fq(n.path)}\n            printf '%s\\t%s\\n' ${fishItems(n.subcommands)}`);

  const optArms = nodes
    .filter(n => n.options.length)
    .map(n => `        case ${fq(n.path)}\n            printf '%s\\t%s\\n' ${fishItems(n.options)}`);

  const valArms = [...valueGroups(nodes)].map(([values, keys]) =>
    `        case ${keys.map(fq).join(' ')}\n            printf '%s\\n' ${values.split(' ').map(fq).join(' ')}`);

  const argArms = nodes
    .filter(n => n.args.length)
    .map(n => `        case ${fq(n.path)}\n            printf '%s\\n' ${n.args.map(fq).join(' ')}`);

  return `${header('fish', version, [
    'Install:  nansen completion fish > ~/.config/fish/completions/nansen.fish',
  ])}

function __nansen_flags
    echo ${fq(valuelessFlags.join(' '))}
end

# A single-dash token never takes a value; only --long options need the lookup.
# The "--" matters: the flag list itself starts with "--", and without it
# string split reads the list as its own options.
function __nansen_is_flag
    string match -q -- '--*' $argv[1]; or return 0
    contains -- $argv[1] (string split -- ' ' (__nansen_flags))
end

function __nansen_subs
    switch "$argv[1]"
${subArms.join('\n')}
    end
end

function __nansen_opts
    switch "$argv[1]"
${optArms.join('\n')}
    end
end

function __nansen_values
    switch "$argv[1]|$argv[2]"
${valArms.join('\n')}
    end
end

# Positional argument values; offered alongside subcommands, never part of the path.
function __nansen_args
    switch "$argv[1]"
${argArms.join('\n')}
    end
end

function __nansen_global_opts
    printf '%s\\t%s\\n' ${fishItems(globalOptions)}
end

# See the bash script: a bare word extends the path only where it is a real
# subcommand, which keeps option values and positionals out of it.
function __nansen_path
    # -opc is deprecated in fish 4 in favour of -xpc, but is the only spelling
    # that also works on fish 3. Revisit once fish 3 support is dropped.
    set -l tokens (commandline -opc)
    set -l path ''
    set -l skip 0
    set -l count (count $tokens)
    if test $count -ge 2
        for i in (seq 2 $count)
            set -l word $tokens[$i]
            if test $skip -eq 1
                set skip 0
                continue
            end
            if string match -q -- '-*' $word
                if not __nansen_is_flag $word
                    set skip 1
                end
                continue
            end
            if contains -- $word (__nansen_subs "$path" | string replace -r '\\t.*$' '')
                if test -z "$path"
                    set path $word
                else
                    set path "$path $word"
                end
            end
        end
    end
    echo $path
end

function __nansen_complete
    set -l path (__nansen_path)
    set -l cur (commandline -ct)
    set -l tokens (commandline -opc)

    if string match -q -- '-*' $cur
        __nansen_opts "$path"
        __nansen_global_opts
        return
    end

    if test (count $tokens) -ge 2
        set -l prev $tokens[-1]
        if string match -q -- '-*' $prev
            if not __nansen_is_flag $prev
                __nansen_values "$path" "$prev"
                return
            end
        end
    end

    __nansen_subs "$path"
    __nansen_args "$path"
end

complete -c nansen -f -a '(__nansen_complete)'
`;
}

const GENERATORS = { bash: generateBash, zsh: generateZsh, fish: generateFish };

/** Render the completion script for one shell. Throws on an unknown shell. */
export function generateCompletion(shell, spec = buildCompletionSpec()) {
  const generate = GENERATORS[shell];
  if (!generate) {
    throw new CommandError(
      `Unsupported shell: ${shell}. Run: nansen completion <${COMPLETION_SHELLS.join('|')}>`,
      'INVALID_PARAMS'
    );
  }
  return generate(spec);
}

export const COMPLETION_USAGE = `nansen completion — Generate a shell completion script

USAGE:
  nansen completion bash     Print the bash completion script
  nansen completion zsh      Print the zsh completion script
  nansen completion fish     Print the fish completion script

INSTALL:
  bash   echo 'eval "$(nansen completion bash)"' >> ~/.bashrc
         # or: nansen completion bash > /etc/bash_completion.d/nansen
  zsh    nansen completion zsh > "\${fpath[1]}/_nansen" && compinit
         # or, in ~/.zshrc after the compinit line: eval "$(nansen completion zsh)"
  fish   nansen completion fish > ~/.config/fish/completions/nansen.fish

Completions cover nested subcommands, per-command flags, global flags, and the
enum values a flag accepts. They are generated from the same schema as
\`nansen schema\`, so re-run this after upgrading the CLI.`;

export function buildCompletionCommands(deps = {}) {
  const { log = console.log } = deps;

  return {
    // --help never reaches here: runCLI answers it from schema.json first.
    'completion': async (args) => {
      const shell = args[0];
      if (!shell) {
        log(COMPLETION_USAGE);
        return undefined;
      }
      log(generateCompletion(shell));
      return undefined;
    },
  };
}
