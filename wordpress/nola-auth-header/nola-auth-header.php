<?php
/**
 * Plugin Name:       NOLA Auth Header Fix
 * Plugin URI:        https://github.com/robertkgaudet/nola-archive
 * Description:       Restores the HTTP Authorization header when the web server strips it, so WordPress REST API application passwords can authenticate. Silently no-ops when the header already arrives intact.
 * Version:           1.0.0
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
 * SAPI populates those two automatically from the header; under CGI/FastCGI it
 * does not. So recovering HTTP_AUTHORIZATION alone is not enough — this plugin
 * also decodes the Basic credential into PHP_AUTH_USER / PHP_AUTH_PW, which is
 * the step that actually makes authentication work.
 *
 * SAFETY
 * ------
 * Every branch is guarded. If the header is already usable, if the recovery
 * functions are unavailable, or if the value is malformed, the plugin returns
 * without touching anything. It writes nothing to the error log, adds no admin
 * UI, registers no routes, and makes no network calls. It cannot make an
 * already-working site behave differently.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

if ( ! function_exists( 'nola_auth_header_recover' ) ) :

	/**
	 * Recover the Authorization header and expose it the way WordPress expects.
	 *
	 * Idempotent and safe to call repeatedly — it returns immediately once
	 * PHP_AUTH_USER is populated.
	 *
	 * @return void
	 */
	function nola_auth_header_recover() {

		// Already usable — either the SAPI populated these, or we already ran.
		if ( ! empty( $_SERVER['PHP_AUTH_USER'] ) ) {
			return;
		}

		$auth = '';

		// 1. The header as PHP normally exposes it.
		if ( ! empty( $_SERVER['HTTP_AUTHORIZATION'] ) ) {
			$auth = $_SERVER['HTTP_AUTHORIZATION'];

		// 2. Apache rewrites commonly land it here instead.
		} elseif ( ! empty( $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ) ) {
			$auth = $_SERVER['REDIRECT_HTTP_AUTHORIZATION'];

		// 3. Ask the SAPI directly. Availability varies by server and PHP build,
		//    so both names are tried and failures are non-fatal.
		} else {
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
					if ( 0 === strcasecmp( $key, 'Authorization' ) && '' !== $value ) {
						$auth = $value;
						break 2;
					}
				}
			}
		}

		if ( '' === $auth || ! is_string( $auth ) ) {
			return;
		}

		// Put it back where other code expects to find it.
		$_SERVER['HTTP_AUTHORIZATION'] = $auth;

		// The load-bearing part: decode Basic into the two variables WordPress
		// actually reads. Anything that is not well-formed Basic is left alone,
		// so Bearer tokens and other schemes pass through untouched.
		if ( 0 === stripos( $auth, 'basic ' ) ) {
			$decoded = base64_decode( substr( $auth, 6 ), true );

			if ( false !== $decoded && false !== strpos( $decoded, ':' ) ) {
				list( $user, $pass ) = explode( ':', $decoded, 2 );

				if ( '' !== $user ) {
					$_SERVER['PHP_AUTH_USER'] = $user;
					$_SERVER['PHP_AUTH_PW']   = $pass;
				}
			}
		}
	}

endif;

/*
 * Run immediately at file scope. WordPress resolves the current user via the
 * determine_current_user filter the first time it is needed, which on a REST
 * request can be before init — so waiting for a hook risks being too late.
 * The hooks below are belt-and-braces for load orders where this file is
 * included unusually early; the function no-ops on every call after the first.
 */
nola_auth_header_recover();

add_action( 'plugins_loaded', 'nola_auth_header_recover', 0 );
add_action( 'init', 'nola_auth_header_recover', 0 );
