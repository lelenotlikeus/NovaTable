use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use sha2::{Digest, Sha512};

const HASH_ROUNDS: usize = 1_000;

/// Produces the exact password representation expected by Servatrice.
///
/// Cockatrice hashes the UTF-8 bytes of `salt + password`, then hashes the
/// resulting 64-byte digest another 999 times. The salt is prepended to the
/// Base64-encoded final digest.
pub fn cockatrice_password_hash(password: &str, salt: &str) -> String {
    let mut input = Vec::with_capacity(salt.len() + password.len());
    input.extend_from_slice(salt.as_bytes());
    input.extend_from_slice(password.as_bytes());

    let mut digest = Sha512::digest(&input).to_vec();
    for _ in 1..HASH_ROUNDS {
        digest = Sha512::digest(&digest).to_vec();
    }

    format!("{salt}{}", STANDARD.encode(digest))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_the_cockatrice_regression_vector() {
        let result = cockatrice_password_hash("password", "saltsaltsaltsalt");
        assert_eq!(
            result,
            concat!(
                "saltsaltsaltsalt",
                "vmKoWv975yf+WT2QCXhW48JNzZ2ghGxdgNvuKLBU0h7s6AQHSG72J6QO4ZswuSeq",
                "vBbAXbmgJSRBaSJrgc55WA=="
            )
        );
    }

    #[test]
    fn treats_password_and_salt_as_utf8() {
        let first = cockatrice_password_hash("màgia", "sale");
        let second = cockatrice_password_hash("magia", "sale");
        assert_ne!(first, second);
        assert!(first.starts_with("sale"));
    }
}
