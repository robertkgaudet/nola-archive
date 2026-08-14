<?php
/**
 * Plugin Name:       NOLA Auth Header Fix
 * Plugin URI:        https://github.com/robertkgaudet/nola-archive
 * Description:       Restores the HTTP Authorization header when the web server strips it, so WordPress REST API application passwords can authenticate. Includes a read-only diagnostic endpoint. Silently no-ops when the header already arrives intact.
 * Version:           1.1.0
 * Author:            Trustlight
 * License:           GPL-2.0-or-later
 * Requires at least: 5.6
 * Requires PHP:      7.0
 *
 * WHY THIS EXISTS
 * ---------------
 * On Apache/LiteSpeed running PHP as CGI/FastCGI, the Authorization header is
 * not passed through to PHP. WordPress therefore never sees the credential and
 * every authenticated REST request returns 401 rest_not_logged_in — the same
 * response it gives when no credential was sent at all.
 *
 * WHAT WORDPRESS ACTUALLY READS
 * -----------------------------
 * wp_validate_application_password() checks $_SERVER['PHP_AUTH_USER'] and
 * $_SERVER['PHP_AUTH_PW'], NOT the raw Authorization header. Under mod_php the
 * SAPI populates those two automatically; under CGI/FastCGI it does not. So
 * recovering HTTP_AUTHORIZATION alone is not enough — this plugin also decodes
 * the Basic credential into PHP_AUTH_USER / PHP_AUTH_PW.
 *
 * DIAGNOSTIC ENDPOINT
 * -------------------
 * GET /wp-json/nola-auth/v1/diag  (public, read-only)
 *
 * Reports which authorization-bearing server variables and request headers
 * reach PHP. It returns BOOLEANS AND HEADER NAMES ONLY — never a header value,
 * never a credential, never a username. Its purpose is to distinguish "the
 * plugin is not running" from "the header never reaches PHP", which cannot be
 * told apart from a 401 alone. Remove this plugin once auth works.
 *
 * SAFETY
 * ------
 * Every branch is guarded. If the header is already usable, if the recovery
 * functions are unavailable, or if the value is malformed, the plugin returns
 * without touching anything. It writes nothing to the error log and makes no
 * network calls.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'NOLA_AUTH_HEADER_VERSION', '1.1.0' );

/**
 * Header names that may carry the credential when the server strips the
 * standard one. Checked in order; the first non-empty value wins.
 */
if ( ! function_exists( 'nola_auth_header_candidates' ) ) {
	function nola_auth_header_candidates() {
		return array(
			'HTTP_AUTHORIZATION',
			'REDIRECT_HTTP_AUTHORIZATION',
			'REDIRECT_REDIRECT_HTTP_AUTHORIZATION',
			'HTTP_X_AUTHORIZATION',        // sent as X-Authorization
			'HTTP_X_HTTP_AUTHORIZATION',   // sent as X-HTTP-Authorization
			'PHP_AUTH_DIGEST',
		);
	}
}

if ( ! function_exists( 'nola_auth_header_recover' ) ) :

	/**
	 * Recover the Authorization header and expose it the way WordPress expects.
	 * Idempotent — returns immediately once PHP_AUTH_USER is populated.
	 *
	 * @return bool True if this call populated the credential.
	 */
	function nola_auth_header_recover() {

		// Already usable — either the SAPI populated these, or we already ran.
		if ( ! empty( $_SERVER['PHP_AUTH_USER'] ) ) {
			return false;
		}

		$auth = '';

		// 1. Any of the server variables the credential might land in.
		foreach ( nola_auth_header_candidates() as $key ) {
			if ( ! empty( $_SERVER[ $key ] ) && is_string( $_SERVER[ $key ] ) ) {
				$auth = $_SERVER[ $key ];
				break;
			}
		}

		// 2. Ask the SAPI directly. Availability varies by server and PHP build,
		//    so both names are tried and failures are non-fatal.
		if ( '' === $auth ) {
			foreach ( array( 'apache_request_headers', 'getallheaders' ) as $fn ) {
				if ( ! function_exists( $fn ) ) {
					continue;
				}

				$headers = @call_user_func( $fn ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
				if ( ! is_array( $headers ) ) {
					continue;
				}

				foreach ( $headers as $key => $value ) {
					// Header names are case-insensitive; servers disagree on casing.
					if ( '' === $value || ! is_string( $value ) ) {
						continue;
					}
					if ( 0 === strcasecmp( $key, 'Authorization' )
						|| 0 === strcasecmp( $key, 'X-Authorization' )
						|| 0 === strcasecmp( $key, 'X-HTTP-Authorization' ) ) {
						$auth = $value;
						break 2;
					}
				}
			}
		}

		if ( '' === $auth ) {
			return false;
		}

		// Put it back where other code expects to find it.
		$_SERVER['HTTP_AUTHORIZATION'] = $auth;

		// The load-bearing part: decode Basic into the two variables WordPress
		// actually reads. Non-Basic schemes are left untouched so Bearer tokens
		// pass through unharmed.
		if ( 0 === stripos( $auth, 'basic ' ) ) {
			$decoded = base64_decode( substr( $auth, 6 ), true );

			if ( false !== $decoded && false !== strpos( $decoded, ':' ) ) {
				list( $user, $pass ) = explode( ':', $decoded, 2 );

				if ( '' !== $user ) {
					$_SERVER['PHP_AUTH_USER'] = $user;
					$_SERVER['PHP_AUTH_PW']   = $pass;
					return true;
				}
			}
		}

		return false;
	}

endif;

/*
 * Run immediately at file scope. WordPress resolves the current user via the
 * determine_current_user filter the first time it is needed, which on a REST
 * request can be before init — so waiting for a hook risks being too late.
 */
$GLOBALS['nola_auth_header_recovered'] = nola_auth_header_recover();

add_action( 'plugins_loaded', 'nola_auth_header_recover', 0 );
add_action( 'init', 'nola_auth_header_recover', 0 );

/**
 * Read-only diagnostic. Booleans and header NAMES only — no values, ever.
 */
add_action( 'rest_api_init', function () {
	register_rest_route(
		'nola-auth/v1',
		'/diag',
		array(
			'methods'             => 'GET',
			'permission_callback' => '__return_true',
			'callback'            => function () {

				$present = array();
				foreach ( nola_auth_header_candidates() as $key ) {
					$present[ $key ] = ! empty( $_SERVER[ $key ] );
				}

				// Header NAMES only. Values are never read or returned.
				$header_names   = array();
				$getallheaders  = false;
				foreach ( array( 'apache_request_headers', 'getallheaders' ) as $fn ) {
					if ( ! function_exists( $fn ) ) {
						continue;
					}
					$getallheaders = true;
					$headers       = @call_user_func( $fn ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
					if ( is_array( $headers ) ) {
						$header_names = array_map( 'strval', array_keys( $headers ) );
					}
					break;
				}

				// Which $_SERVER keys look header-ish, by name only.
				$server_http_keys = array();
				foreach ( array_keys( $_SERVER ) as $k ) {
					if ( 0 === strpos( $k, 'HTTP_' ) || 0 === strpos( $k, 'REDIRECT_' ) || 0 === strpos( $k, 'PHP_AUTH' ) ) {
						$server_http_keys[] = $k;
					}
				}
				sort( $server_http_keys );

				return array(
					'plugin_version'          => NOLA_AUTH_HEADER_VERSION,
					'plugin_is_running'       => true,
					'php_sapi'                => PHP_SAPI,
					'server_software'         => isset( $_SERVER['SERVER_SOFTWARE'] ) ? $_SERVER['SERVER_SOFTWARE'] : null,
					'app_passwords_available' => function_exists( 'wp_is_application_passwords_available' )
						? (bool) wp_is_application_passwords_available()
						: null,
					'authorization_sources'   => $present,
					'php_auth_user_present'   => ! empty( $_SERVER['PHP_AUTH_USER'] ),
					'recovered_by_plugin'     => ! empty( $GLOBALS['nola_auth_header_recovered'] ),
					'getallheaders_available' => $getallheaders,
					'request_header_names'    => $header_names,
					'server_header_keys'      => $server_http_keys,
					'note'                    => 'Names and booleans only. No header values or credentials are returned.',
				);
			},
		)
	);
} );
