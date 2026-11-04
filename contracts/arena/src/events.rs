use near_sdk::env;
use near_sdk::serde_json::{json, Value};

const STANDARD: &str = "valtrum";
const VERSION: &str = "1.0.0";

/// Emits a NEP-297 structured event: `EVENT_JSON:{...}`.
pub fn emit(event: &str, data: Value) {
    let payload = json!({
        "standard": STANDARD,
        "version": VERSION,
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{payload}"));
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::get_logs;

    #[test]
    fn emits_nep297_envelope() {
        emit("battle_approved", json!({ "battle_id": 7 }));
        let logs = get_logs();
        assert_eq!(logs.len(), 1);
        let body = logs[0].strip_prefix("EVENT_JSON:").unwrap();
        let parsed: Value = near_sdk::serde_json::from_str(body).unwrap();
        assert_eq!(parsed["standard"], "valtrum");
        assert_eq!(parsed["version"], "1.0.0");
        assert_eq!(parsed["event"], "battle_approved");
        assert_eq!(parsed["data"][0]["battle_id"], 7);
    }
}
