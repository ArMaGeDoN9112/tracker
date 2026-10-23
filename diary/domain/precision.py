import re


def tenths(value: str) -> int:
    value = value.strip().replace(",", ".")
    if not re.fullmatch(r"\+?[0-9]+(?:\.[0-9]+)?", value):
        raise ValueError("Введите десятичное число.")
    whole, _, fraction = value.lstrip("+").partition(".")
    if fraction[1:].strip("0") or len(whole.lstrip("0")) > 9:
        raise ValueError("Допустим один значащий знак после запятой и значение до 214748364,7.")
    result = int(whole.lstrip("0") or "0") * 10 + int((fraction + "0")[0])
    if result > 2147483647:
        raise ValueError("Превышен технический предел 214748364,7.")
    return result


def decimal_string(value: int) -> str:
    return f"{value // 10}.{value % 10}"


def hundredths(value: str) -> int:
    value = value.strip().replace(",", ".")
    if not re.fullmatch(r"\+?[0-9]+(?:\.[0-9]+)?", value):
        raise ValueError("Введите неотрицательное десятичное число.")
    whole, _, fraction = value.lstrip("+").partition(".")
    if fraction[2:].strip("0") or len(whole.lstrip("0")) > 8:
        raise ValueError("Допустимы сотые, максимум 21474836,47 ед/ч.")
    result = int(whole.lstrip("0") or "0") * 100 + int((fraction + "00")[:2])
    if result > 2147483647:
        raise ValueError("Превышен технический предел 21474836,47 ед/ч.")
    return result


def rate_string(value: int) -> str:
    return f"{value // 100}.{value % 100:02}"
