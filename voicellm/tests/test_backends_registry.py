import unittest

from voxagent.backends import create_llm, create_tts


class TestBackendRegistry(unittest.TestCase):
    def test_create_llm_rejects_unknown_backend(self):
        with self.assertRaises(ValueError):
            create_llm({"backend": "does-not-exist"})

    def test_create_tts_rejects_unknown_backend(self):
        with self.assertRaises(ValueError):
            create_tts({"backend": "does-not-exist"}, {})


if __name__ == "__main__":
    unittest.main()
