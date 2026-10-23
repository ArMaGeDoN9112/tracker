def validate_password(password: str) -> None:
    if not 15 <= len(password) <= 1024:
        raise ValueError("Пароль должен содержать от 15 до 1024 символов.")


def validate_login(login: str) -> str:
    login = login.strip()
    if not 1 <= len(login) <= 128:
        raise ValueError("Логин должен содержать от 1 до 128 символов.")
    return login
