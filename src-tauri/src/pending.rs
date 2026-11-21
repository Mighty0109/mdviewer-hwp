//! The lock around this state makes draining and switching to live delivery atomic.
#[derive(Default)]
pub struct PendingFiles {
    ready: bool,
    paths: Vec<String>,
}

impl PendingFiles {
    /// Returns true when the caller should deliver a live event instead of queueing.
    pub fn opened(&mut self, path: String) -> bool {
        if self.ready {
            return true;
        }
        if !self.paths.contains(&path) {
            self.paths.push(path);
        }
        false
    }

    pub fn take(&mut self) -> Vec<String> {
        self.ready = true;
        std::mem::take(&mut self.paths)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cold_requests_are_deduplicated_and_drained_then_warm_requests_are_live() {
        let mut pending = PendingFiles::default();
        assert!(!pending.opened("/a.md".into()));
        assert!(!pending.opened("/a.md".into()));
        assert!(!pending.opened("/b.md".into()));
        assert_eq!(pending.take(), ["/a.md", "/b.md"]);
        assert!(pending.take().is_empty());
        assert!(pending.opened("/c.md".into()));
        assert!(pending.take().is_empty());
    }
}
