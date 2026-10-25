# Testing the npm package locally

Use the packed npm artifact for release testing. Installing the tarball into a
temporary npm prefix is closer to a real global installation than running the
source tree directly, and it does not modify the host's global npm packages.

## Build and inspect the package

Run the project checks first:

~~~bash
npm run typecheck
npm test
npm run build
npm pack --dry-run
~~~

The dry run lists the files that would be published. Check that it contains the
compiled server and `dist/client`, and does not contain local databases,
projects, credentials, or development-only files.

## Install the tarball into an isolated prefix

Create a temporary directory, pack the current version, and install it without
touching the real global npm installation:

~~~bash
TEST_ROOT="$(mktemp -d /tmp/texlite-package-test.XXXXXX)"
PACKAGE_VERSION="$(node -p "require('./package.json').version")"
PACKAGE_FILE="texlite-${PACKAGE_VERSION}.tgz"

npm pack --pack-destination "$TEST_ROOT"
npm_config_cache="$TEST_ROOT/npm-cache" \
npm install --omit=dev --prefix "$TEST_ROOT/prefix" --global "$TEST_ROOT/$PACKAGE_FILE"

"$TEST_ROOT/prefix/bin/texlite" --version
"$TEST_ROOT/prefix/bin/texlite" --help
~~~

The version in `PACKAGE_FILE` is read from `package.json`, so the commands also
work after a version bump.

Frontend libraries are development dependencies. The tarball already contains
the built application, PDF worker, formatter WASM, fonts, and generated Lucide
SVGs; the installed server must work without the frontend packages or build
tools in `node_modules`. Run the installed commands from outside the source
checkout to avoid accidentally resolving dependencies from its `node_modules`.
Check math previews, PDF preview, formatting, bibliography editing, and a custom
project icon in the browser as well as the server workflows below. Source
development and release builds still require `npm ci` with development
dependencies included.

## Test configuration, data paths, and environment checks

Use temporary XDG directories and a non-interactive administrator account:

~~~bash
"$TEST_ROOT/prefix/bin/texlite" requirements

XDG_CONFIG_HOME="$TEST_ROOT/config" \
XDG_DATA_HOME="$TEST_ROOT/data" \
TEXLITE_SITE_NAME='TexLite Package Test' \
TEXLITE_ADMIN_EMAIL='' \
TEXLITE_INIT_USERNAME=admin \
TEXLITE_INIT_DISPLAY_NAME=Administrator \
TEXLITE_INIT_PASSWORD='use-a-password-of-at-least-8-characters' \
"$TEST_ROOT/prefix/bin/texlite" init

XDG_CONFIG_HOME="$TEST_ROOT/config" \
XDG_DATA_HOME="$TEST_ROOT/data" \
"$TEST_ROOT/prefix/bin/texlite" config

XDG_CONFIG_HOME="$TEST_ROOT/config" \
XDG_DATA_HOME="$TEST_ROOT/data" \
"$TEST_ROOT/prefix/bin/texlite" doctor
~~~

The `config` output should show the temporary configuration and data paths.
The generated JSON is intentionally minimal: unspecified settings are omitted
and resolved at runtime. The explicit test site name is saved; default history,
compiler, PDF and other settings should not be copied into the file.
`requirements` is safe before initialization: it checks only default host
commands on `PATH` and does not read the temporary configuration or data.
`doctor` verifies the configuration, database, administrator, and required
host software in a table. It also reports optional Git, TeXcount,
bibliography/index, and Harper tools without treating their absence as a
failure to start TexLite.

To verify the configurable data directory explicitly:

~~~bash
XDG_CONFIG_HOME="$TEST_ROOT/config" \
XDG_DATA_HOME="$TEST_ROOT/data" \
TEXLITE_DATA_DIR="$TEST_ROOT/custom-data" \
"$TEST_ROOT/prefix/bin/texlite" config
~~~

## Test the foreground server

Run the installed package in the foreground:

~~~bash
XDG_CONFIG_HOME="$TEST_ROOT/config" \
XDG_DATA_HOME="$TEST_ROOT/data" \
"$TEST_ROOT/prefix/bin/texlite" serve
~~~

Open <http://127.0.0.1:3000> in a browser and exercise login, project
creation, editing, compilation, file upload, comments, and PDF preview. Press
Ctrl+C to stop the server.

The package requires Node.js 24 or newer and the LaTeX engines enabled in the
selected configuration.

## Test optional external agent terminals

On the isolated test installation, sign in as an administrator and open
**Coding Agent CLI**. The default agent allowlist must be empty. Confirm that missing
commands are reported without blocking normal project editing, then allow only
the agents intentionally configured for this test.

In a writable project, open **Terminal**, create a task and explicitly start it.
Verify input, resize, browser reconnect, and end execution. Make a small direct
source edit and check live editor synchronization, attributed history and comment
anchors. Another user's/agent's task in the same project must fail to start until
the first execution ends. Delete the task and verify project files remain.
Never use a real model for an automated
package smoke test; the integration tests use deterministic fake agents.

For a second package installation, `npm install --omit=dev --omit=optional` must
still allow normal startup and login; the external-tools page should report
unavailable terminal support. Terminal resources must be present in the built
browser assets even though xterm packages are development dependencies.

## Test the PM2 lifecycle in isolation

Use both a private `PM2_HOME` and a test-only port. Every lifecycle command must
receive the same environment so it addresses the same configuration and PM2
daemon without touching the host user's real processes:

~~~bash
PM2_HOME="$TEST_ROOT/pm2" \
XDG_CONFIG_HOME="$TEST_ROOT/config" \
XDG_DATA_HOME="$TEST_ROOT/data" \
TEXLITE_PORT=3300 \
"$TEST_ROOT/prefix/bin/texlite" start

PM2_HOME="$TEST_ROOT/pm2" \
XDG_CONFIG_HOME="$TEST_ROOT/config" \
XDG_DATA_HOME="$TEST_ROOT/data" \
TEXLITE_PORT=3300 \
"$TEST_ROOT/prefix/bin/texlite" status

PM2_HOME="$TEST_ROOT/pm2" \
XDG_CONFIG_HOME="$TEST_ROOT/config" \
XDG_DATA_HOME="$TEST_ROOT/data" \
TEXLITE_PORT=3300 \
"$TEST_ROOT/prefix/bin/texlite" stop
~~~

The custom XDG configuration receives a path-derived PM2 name such as
`texlite-a1b2c3d4`; the private `PM2_HOME` additionally prevents the test daemon
and logs from mixing with the normal installation.

Remove the temporary test installation when finished:

~~~bash
rm -rf "$TEST_ROOT"
~~~
