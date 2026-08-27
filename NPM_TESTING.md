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
npm install --prefix "$TEST_ROOT/prefix" --global "$TEST_ROOT/$PACKAGE_FILE"

"$TEST_ROOT/prefix/bin/texlite" --version
"$TEST_ROOT/prefix/bin/texlite" --help
~~~

The version in `PACKAGE_FILE` is read from `package.json`, so the commands also
work after a version bump.

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
