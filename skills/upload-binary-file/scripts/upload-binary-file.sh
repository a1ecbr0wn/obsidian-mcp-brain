#!/bin/sh
# Helper for the obsidian-mcp-brain `upload-binary-file` tool.
#
#   upload-binary-file.sh prepare <file>        print filename=, size= and sha256= for the tool call
#   upload-binary-file.sh send <file> <url>     PUT the file to the one-time URL the tool returned
#
# Needs curl (for send) and one SHA-256 tool: sha256sum, shasum, or openssl.
# Exit status: 0 success, 1 failure, 2 wrong usage. The token in the URL is never printed.

set -u

usage() {
  cat >&2 <<'EOF'
Usage:
  upload-binary-file.sh prepare <file>
  upload-binary-file.sh send <file> <url>
EOF
  exit 2
}

die() {
  printf 'upload-binary-file: %s\n' "$*" >&2
  exit 1
}

# Replaces the token in anything echoed back to the terminal.
redact() {
  sed 's#/up/[A-Za-z0-9_-]*#/up/<redacted>#g'
}

check_file() {
  [ -f "$1" ] || die "'$1' is not a regular file (missing, or a directory or special file)"
  [ -r "$1" ] || die "cannot read '$1'"
}

# Chooses the hashing tool once, at the top level, so a failure ends the script.
choose_hasher() {
  if command -v sha256sum >/dev/null 2>&1; then
    HASHER=sha256sum
  elif command -v shasum >/dev/null 2>&1; then
    HASHER=shasum
  elif command -v openssl >/dev/null 2>&1; then
    HASHER=openssl
  else
    die 'no SHA-256 tool found: install sha256sum, shasum or openssl'
  fi
}

hash_of() {
  case "$HASHER" in
    sha256sum) sha256sum "$1" ;;
    shasum)    shasum -a 256 "$1" ;;
    openssl)   openssl dgst -sha256 "$1" ;;
  esac | {
    # sha256sum/shasum print "<hash>  <name>"; openssl prints "SHA2-256(<name>)= <hash>".
    read -r first second
    case "$first" in
      *=) printf '%s\n' "$second" ;;
      *)  case "$second" in
            *=*) printf '%s\n' "${second##*= }" ;;
            *)   printf '%s\n' "$first" ;;
          esac ;;
    esac
  }
}

size_of() {
  n=$(wc -c < "$1")
  set -- $n
  printf '%s\n' "$1"
}

# Pulls one string or number field out of a small JSON object without needing jq.
json_field() {
  printf '%s' "$2" | sed -n "s/.*\"$1\":[ ]*\"\\([^\"]*\\)\".*/\\1/p;s/.*\"$1\":[ ]*\\([0-9][0-9]*\\).*/\\1/p" | head -n 1
}

cmd_prepare() {
  [ $# -eq 1 ] || usage
  file=$1
  check_file "$file"
  choose_hasher
  printf 'filename=%s\n' "${file##*/}"
  printf 'size=%s\n' "$(size_of "$file")"
  printf 'sha256=%s\n' "$(hash_of "$file")"
}

cmd_send() {
  [ $# -eq 2 ] || usage
  file=$1
  url=$2
  check_file "$file"
  case "$url" in
    http://*/up/* | https://*/up/*) ;;
    *) die 'the URL must be the one returned by upload-binary-file (http(s)://.../up/<token>)' ;;
  esac
  command -v curl >/dev/null 2>&1 || die 'curl is required'
  choose_hasher

  want_size=$(size_of "$file")
  want_hash=$(hash_of "$file")

  body=$(mktemp) || die 'cannot create a temporary file'
  errs=$(mktemp) || die 'cannot create a temporary file'
  trap 'rm -f "$body" "$errs"' EXIT

  status=$(curl -sS -T "$file" -o "$body" -w '%{http_code}' "$url" 2>"$errs")
  curl_exit=$?
  reply=$(cat "$body")

  if [ "$curl_exit" -ne 0 ] || [ "$status" = 000 ]; then
    redact < "$errs" >&2
    die "the upload did not complete (curl exit $curl_exit)"
  fi

  case "$status" in
    2??) ;;
    *)
      message=$(json_field error "$reply")
      [ -n "$message" ] || message=$reply
      die "the server answered $status: $message"
      ;;
  esac

  got_path=$(json_field path "$reply")
  got_bytes=$(json_field bytes "$reply")
  got_hash=$(json_field sha256 "$reply")

  [ "$got_bytes" = "$want_size" ] || die "the server reports $got_bytes bytes but the local file is $want_size bytes"
  [ "$got_hash" = "$want_hash" ] || die "the server's sha256 does not match the local file's (server $got_hash, local $want_hash)"

  printf 'uploaded %s (%s bytes, sha256 %s), verified against the local file\n' "$got_path" "$got_bytes" "$got_hash"
}

[ $# -ge 1 ] || usage
sub=$1
shift
case "$sub" in
  prepare) cmd_prepare "$@" ;;
  send)    cmd_send "$@" ;;
  *)       usage ;;
esac
