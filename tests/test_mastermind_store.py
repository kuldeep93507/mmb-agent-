"""Tests for mastermind_store — isolated persistence."""

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from server_python import mastermind_store as ms


class MastermindStoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.file = Path(self.tmp.name) / "mastermind_data.json"
        self.patcher = patch.object(ms, "MASTERMIND_FILE", self.file)
        self.patcher.start()

    def tearDown(self):
        self.patcher.stop()
        self.tmp.cleanup()

    def test_save_and_load_campaign(self):
        payload = {
            "goals": {"views": 100},
            "defaults": {"tabsPerProfile": 1},
            "videos": [{"id": "v1", "viewGoal": 100}],
            "overrides": {},
        }
        result = ms.save_campaign(payload)
        self.assertTrue(result["success"])
        state = ms.get_state()
        self.assertEqual(state["campaign"]["goals"]["views"], 100)
        self.assertEqual(len(state["campaign"]["videos"]), 1)

    def test_save_plan_history(self):
        ms.save_campaign({
            "goals": {"views": 10},
            "defaults": {},
            "videos": [],
            "overrides": {},
        })
        plan = {"dayKey": "2026-06-07", "totalSlots": 5, "slots": []}
        r = ms.save_plan({"plan": plan, "name": "Test plan"})
        self.assertTrue(r["success"])
        state = ms.get_state()
        self.assertIsNotNone(state["latestPlan"])
        self.assertEqual(state["latestPlan"]["totalSlots"], 5)
        self.assertEqual(len(state["planHistory"]), 1)

    def test_save_scheduled_plan(self):
        plan = {
            "dayKey": "2026-06-12",
            "totalSlots": 3,
            "slots": [{
                "id": "s1",
                "profileId": "p1",
                "videoId": "vid1",
                "scheduledAt": "2026-06-12T10:00:00.000Z",
                "scheduledEndAt": "2026-06-12T10:15:00.000Z",
            }],
        }
        r = ms.save_scheduled_plan({
            "plan": plan,
            "targetDate": "2026-06-12",
            "name": "Day 1 test",
            "autoStart": True,
        })
        self.assertTrue(r["success"])
        items = ms.list_scheduled_plans()
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["targetDate"], "2026-06-12")
        self.assertEqual(items[0]["status"], "pending")
        state = ms.get_state()
        self.assertEqual(len(state["scheduledPlans"]), 1)
        deleted = ms.delete_scheduled_plan(items[0]["id"])
        self.assertTrue(deleted["success"])
        self.assertEqual(len(ms.list_scheduled_plans()), 0)


if __name__ == "__main__":
    unittest.main()
