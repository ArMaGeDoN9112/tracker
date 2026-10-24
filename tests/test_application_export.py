from contextlib import contextmanager

from diary.application.export import ExportData, ExportDiary


def test_export_reads_complete_history_with_injected_clock():
    data = ExportData(account={'id': 1, 'login': 'owner', 'created_at': 0},
                      settings={'volumes_ml': [250], 'revision': 1},
                      entries=[], schedules=[], temporary=[], products=[], meals=[], water=[])

    @contextmanager
    def snapshot():
        class Store:
            def read(self):
                return data
        yield Store()

    result = ExportDiary(snapshot, lambda: 1234).execute()
    assert result.exported_at == 1234
    assert result.account.login == 'owner'
    assert result.settings.volumes_ml == [250]
    assert result.entries == result.meals == result.water == []
