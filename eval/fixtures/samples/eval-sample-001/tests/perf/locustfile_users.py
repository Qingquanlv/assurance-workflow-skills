"""Eval smoke Locust load test for users module."""
from locust import HttpUser, between, task


class UserListUser(HttpUser):
    wait_time = between(1, 2)

    @task
    def user_list(self):
        self.client.get("/api/v1/user/list", name="user-list-query")
